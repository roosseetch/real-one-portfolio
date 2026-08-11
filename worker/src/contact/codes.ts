/**
 * Proving that whoever typed an address can read the mail sent to it.
 *
 * Three CSV files carry the whole state, and there is no timer anywhere: an
 * expired code is not deleted when it expires, it is deleted the next time
 * somebody asks for a code. Issuing walks the file from the oldest line down,
 * dropping what has aged out and stopping at the first line that has not — so
 * the file is trimmed by the traffic that would otherwise grow it, and a form
 * nobody uses costs nothing to keep tidy.
 *
 * A resent code does not replace the one before it. Somebody who asks again
 * because the first mail was slow will very often then find the first one and
 * type it, and refusing that would be punishing them for our latency.
 */
import { timingSafeEqual } from "../crypto";
import { appendRow, CODES_KEY, MESSAGES_KEY, readCsv, updateCsv, VERIFIED_KEY } from "./records";

/** How long a code is worth typing. The issue's thirty minutes. */
export const CODE_TTL_MS = 30 * 60 * 1000;

/** Wrong guesses a code survives. The fourth is refused whatever it says. */
export const MAX_ATTEMPTS = 3;

/**
 * How long a verified address stays verified.
 *
 * Not in the issue, and chosen with the author: a returning sender inside a
 * month goes straight through, and after that proves the address again.
 */
export const VERIFIED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Live codes one address may hold at once.
 *
 * Every one of them is an email somebody asked us to send, and the person who
 * receives them did not necessarily ask. Five is enough for a slow inbox and
 * far short of a way to bury somebody in mail.
 */
export const MAX_LIVE_CODES = 5;

/** codes.csv: address, code, issued at, wrong guesses so far. */
const CODE_COLUMNS = 4;
/** verified.csv: address, verified at. */
const VERIFIED_COLUMNS = 2;

export type IssueOutcome = { status: "issued"; code: string } | { status: "too-many" };
export type RedeemOutcome = "accepted" | "rejected" | "none";

/**
 * Addresses are matched case-insensitively, because `A@Example.com` and
 * `a@example.com` are the same inbox to everyone except a string comparison.
 * What the visitor typed is preserved in messages.csv, where it is a record of
 * what they wrote rather than a key.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * A six-digit code, uniformly distributed.
 *
 * Rejection sampling rather than `% 1000000`, which would make the low values
 * fractionally likelier. It costs one extra draw in about one case in fifty and
 * removes a whole class of "why is this code always low" question.
 */
export function newCode(): string {
  const limit = 4_294_000_000; // The largest multiple of 1e6 under 2^32.
  const buffer = new Uint32Array(1);

  do {
    crypto.getRandomValues(buffer);
  } while (buffer[0] >= limit);

  return String(buffer[0] % 1_000_000).padStart(6, "0");
}

function isLive(row: string[], now: number): boolean {
  if (row.length < CODE_COLUMNS) return false;

  const issued = Date.parse(row[2]);
  if (Number.isNaN(issued)) return false;

  return now - issued < CODE_TTL_MS && Number(row[3]) < MAX_ATTEMPTS;
}

/**
 * The issue's own cleaning rule: take the top line, and if it has aged out drop
 * it and look at the next.
 *
 * Only from the head. Rows are appended in the order they were issued, so the
 * head is the oldest, and stopping at the first live line keeps this O(what was
 * actually removed) rather than O(the whole file) on every request.
 */
function pruneExpiredHead(rows: string[][], now: number): string[][] {
  let first = 0;
  while (first < rows.length) {
    const issued = Date.parse(rows[first]?.[2] ?? "");
    if (!Number.isNaN(issued) && now - issued < CODE_TTL_MS) break;
    first++;
  }

  return first === 0 ? rows : rows.slice(first);
}

/**
 * Issues a code for an address, or refuses because it already holds too many.
 *
 * Returns the code rather than sending it: sending is the caller's, so that a
 * mail that could not be sent is not recorded as one that was.
 */
export async function issueCode(
  bucket: R2Bucket,
  email: string,
  now: Date = new Date(),
): Promise<IssueOutcome> {
  const address = normalizeEmail(email);
  const at = now.getTime();
  const code = newCode();
  let refused = false;

  await updateCsv(bucket, CODES_KEY, (rows) => {
    const kept = pruneExpiredHead(rows, at);
    const live = kept.filter((row) => row[0] === address && isLive(row, at));

    refused = live.length >= MAX_LIVE_CODES;
    if (refused) return kept;

    return [...kept, [address, code, now.toISOString(), "0"]];
  });

  return refused ? { status: "too-many" } : { status: "issued", code };
}

/**
 * Checks a code, and records the address as verified if it was right.
 *
 * A wrong guess costs every live code that address holds one attempt, not just
 * the one it happened to resemble — otherwise holding five codes would buy
 * fifteen guesses, and the limit would mean nothing.
 */
export async function redeemCode(
  bucket: R2Bucket,
  email: string,
  code: string,
  now: Date = new Date(),
): Promise<RedeemOutcome> {
  const address = normalizeEmail(email);
  const at = now.getTime();
  const offered = code.trim();
  // Held on an object rather than in a plain `let`: the assignment happens
  // inside a callback that may run more than once, which is exactly the case
  // the compiler's flow analysis cannot see through.
  const result: { outcome: RedeemOutcome } = { outcome: "none" };

  await updateCsv(bucket, CODES_KEY, (rows) => {
    const live = rows.filter((row) => row[0] === address && isLive(row, at));
    if (live.length === 0) {
      result.outcome = "none";
      return rows;
    }

    const matched = live.some((row) => timingSafeEqual(row[1], offered));
    result.outcome = matched ? "accepted" : "rejected";

    if (matched) {
      // Every code this address holds is spent, not just the one typed. The
      // address is proven now; the others are only unsent mail waiting to be
      // guessed at.
      return rows.filter((row) => row[0] !== address);
    }

    return rows.map((row) =>
      row[0] === address && isLive(row, at)
        ? [row[0], row[1], row[2], String(Number(row[3]) + 1)]
        : row,
    );
  });

  if (result.outcome === "accepted") await recordVerification(bucket, address, now);
  return result.outcome;
}

/** True when this address proved itself inside the window and need not do it again. */
export async function isVerified(
  bucket: R2Bucket,
  email: string,
  now: Date = new Date(),
): Promise<boolean> {
  const address = normalizeEmail(email);
  const rows = await readCsv(bucket, VERIFIED_KEY);

  return rows.some((row) => {
    if (row.length < VERIFIED_COLUMNS || row[0] !== address) return false;

    const verified = Date.parse(row[1]);
    return !Number.isNaN(verified) && now.getTime() - verified < VERIFIED_TTL_MS;
  });
}

/**
 * Writes the address into verified.csv, replacing any earlier line for it.
 *
 * Replaced rather than appended: this file answers one question — when did this
 * address last prove itself — and a row per verification would turn it into a
 * log of how often somebody writes to her.
 */
export async function recordVerification(
  bucket: R2Bucket,
  email: string,
  now: Date = new Date(),
): Promise<void> {
  const address = normalizeEmail(email);

  await updateCsv(bucket, VERIFIED_KEY, (rows) => [
    ...rows.filter((row) => row[0] !== address),
    [address, now.toISOString()],
  ]);
}

/**
 * Appends the message to messages.csv, exactly as the issue asks: every field
 * of the form, plus when it was sent.
 *
 * Worth being clear about what this is. Unlike the submission object, which the
 * bucket expires within days, this file keeps a stranger's name, address,
 * telephone number and words indefinitely. That is what was asked for, and it
 * is a record to delete deliberately rather than one that tidies itself.
 */
export async function recordMessage(
  bucket: R2Bucket,
  message: { name: string; email: string; company?: string; phone?: string; text: string },
  now: Date = new Date(),
): Promise<void> {
  await appendRow(bucket, MESSAGES_KEY, [
    message.name,
    message.email,
    message.company ?? "",
    message.phone ?? "",
    message.text,
    now.toISOString(),
  ]);
}
