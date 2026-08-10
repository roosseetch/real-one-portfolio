/**
 * A durable trace of what went wrong inside a request (spec §24: the Worker
 * must be diagnosable without paying for Log Explorer).
 *
 * `wrangler tail` only shows what happens while someone is watching, so a
 * failure at three in the morning currently leaves nothing behind at all. This
 * keeps the messages the code already writes to `console`, plus any uncaught
 * exception, as one JSON object per failed request in the private bucket.
 *
 * Nothing is threaded through the call graph. `console.error` and
 * `console.warn` are wrapped once and AsyncLocalStorage decides which request
 * an entry belongs to, so every existing call site is captured without being
 * touched. That is safe precisely because those call sites were written for a
 * log anyone could read — short literal messages, error text, status codes,
 * never the author's words and never a secret. Anything added later has to hold
 * to that, because this writes them down.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { randomId } from "../ids";

/** Enough to follow a failure through; short of letting a retry loop fill the bucket. */
const MAX_ENTRIES = 100;

/** Room for a stack trace, without one entry crowding out the rest. */
const MAX_MESSAGE_CHARS = 2000;

export type LogLevel = "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  at: string;
  message: string;
}

export interface RequestLog {
  id: string;
  startedAt: Date;
  method: string;
  /** Path only. No route here uses a query string, and one could carry a token. */
  path: string;
  entries: LogEntry[];
}

const active = new AsyncLocalStorage<RequestLog>();

/** Captured before anything is wrapped, so reporting a logging failure cannot recurse. */
const direct = { warn: console.warn.bind(console), error: console.error.bind(console) };

export function beginRequest(request: Request): RequestLog {
  return {
    id: randomId(8),
    startedAt: new Date(),
    method: request.method,
    path: new URL(request.url).pathname,
    entries: [],
  };
}

/**
 * The same log for a run nobody made a request for.
 *
 * A scheduled invocation is where a durable trace matters most: there is no
 * caller to see a 500 and no chat to answer, so an unnoticed failure of the
 * sweep is exactly the kind that would go on failing quietly. The cron
 * expression stands in for the path — it is a literal from the deployed
 * configuration, so nothing about a draft can reach the log through it.
 */
export function beginScheduled(cron: string): RequestLog {
  return {
    id: randomId(8),
    startedAt: new Date(),
    method: "CRON",
    path: cron,
    entries: [],
  };
}

/** Makes `log` the one that `console` calls inside `work` are recorded against. */
export function runWithLog<T>(log: RequestLog, work: () => T): T {
  return active.run(log, work);
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // A circular object, or one whose toJSON throws. The type is still a clue.
    return Object.prototype.toString.call(value);
  }
}

function record(level: LogLevel, args: unknown[]): void {
  const log = active.getStore();
  if (log === undefined) return;

  if (log.entries.length >= MAX_ENTRIES) {
    // Say once that the tail is missing, so a truncated object is never read as
    // a complete account of the request.
    if (log.entries.length === MAX_ENTRIES) {
      log.entries.push({
        level: "warn",
        at: new Date().toISOString(),
        message: `Stopped recording after ${MAX_ENTRIES} entries.`,
      });
    }
    return;
  }

  log.entries.push({
    level,
    at: new Date().toISOString(),
    message: args.map(describe).join(" ").slice(0, MAX_MESSAGE_CHARS),
  });
}

/** Records something that never went through `console` — an uncaught throw. */
export function recordException(error: unknown): void {
  record("error", [describe(error)]);
}

let installed = false;

/**
 * Wraps `console.warn` and `console.error` so every existing call site feeds the
 * active request's log, while still printing for `wrangler tail`.
 *
 * Idempotent: module scope runs once per isolate, but tests import repeatedly.
 */
export function installConsoleCapture(): void {
  if (installed) return;
  installed = true;

  console.warn = (...args: unknown[]) => {
    direct.warn(...args);
    record("warn", args);
  };
  console.error = (...args: unknown[]) => {
    direct.error(...args);
    record("error", args);
  };
}

/**
 * An ExecutionContext that remembers what was deferred.
 *
 * Album collection, AI generation and the preview all run in `waitUntil`, after
 * the response has gone back to Telegram — which is exactly where a silent
 * failure is hardest to notice. Flushing when `fetch` returns would miss every
 * one of them, so the log waits for the deferred work to settle first.
 *
 * A Proxy rather than a literal: ExecutionContext carries host-backed members
 * (`exports`, `props`, `tracing`) that only work when read off the real object.
 */
export function trackDeferred(ctx: ExecutionContext): {
  context: ExecutionContext;
  settled: () => Promise<void>;
} {
  const pending: Promise<unknown>[] = [];

  const waitUntil = (promise: Promise<unknown>): void => {
    pending.push(promise);
    ctx.waitUntil(promise);
  };

  const context = new Proxy(ctx, {
    get(target, property) {
      if (property === "waitUntil") return waitUntil;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  // Deferred work defers more work — intake schedules generation, which
  // schedules the preview — so this drains rather than awaiting once.
  const settled = async (): Promise<void> => {
    while (pending.length > 0) {
      const results = await Promise.allSettled(pending.splice(0, pending.length));
      for (const result of results) {
        if (result.status === "rejected") recordException(result.reason);
      }
    }
  };

  return { context, settled };
}

/** `logs/2026-08-06/113102-145-4f2a9c1e.json` — sorted by time within a day. */
function logKey(log: RequestLog): string {
  const iso = log.startedAt.toISOString();
  return `logs/${iso.slice(0, 10)}/${iso.slice(11, 23).replace(/[:.]/g, "")}-${log.id}.json`;
}

/**
 * Writes the log, if the request actually went wrong.
 *
 * An error, or a 5xx. A 5xx that recorded nothing still gets an object, because
 * "it failed and said nothing" is the hardest case to reconstruct afterwards.
 *
 * Warnings on their own are not enough. Someone who finds this URL can send an
 * unparseable body all day and each one warns; keeping those would hand a
 * stranger a way to fill the bucket. Warnings are kept only as context around
 * an error. Nothing an anonymous caller can reach answers 5xx — the gate
 * refuses them at 401 first — so neither branch is theirs to drive.
 */
export async function flush(bucket: R2Bucket, log: RequestLog, status: number): Promise<void> {
  const failed = status >= 500 || log.entries.some((entry) => entry.level === "error");
  if (!failed) return;

  const body = {
    id: log.id,
    at: log.startedAt.toISOString(),
    method: log.method,
    path: log.path,
    status,
    durationMs: Date.now() - log.startedAt.getTime(),
    entries: log.entries,
  };

  try {
    await bucket.put(logKey(log), JSON.stringify(body, null, 2), {
      httpMetadata: { contentType: "application/json" },
    });
  } catch (error) {
    // The request already has its answer, and the wrapped console would only
    // append to the log that just failed to be written.
    direct.error(`Could not write the error log: ${describe(error)}`);
  }
}
