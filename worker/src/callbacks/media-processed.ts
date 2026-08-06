/**
 * The authenticated callback GitHub Actions makes once media has been
 * sanitised and uploaded (spec §13).
 *
 * This is the one route a system outside Cloudflare can use to put something on
 * the site, so every one of spec §13.3's ten checks runs before anything is
 * published, and the order matters: authentication first, then whether the
 * request describes a draft we are actually waiting on, and only then the work.
 *
 * Nothing here trusts the body. The media URLs in particular are checked to be
 * on the configured media domain — a signed callback naming an attacker's host
 * would otherwise put their images on her site.
 */
import { hmacSha256Hex, timingSafeEqual } from "../crypto";
import { publishRecord, type PublishEnv } from "../publishing/publish";
import { toPublicRecord, type PublicMedia } from "../content/records";
import { sendMessage, type TelegramApiEnv } from "../telegram/api";
import { transition } from "../drafts/state";
import { loadDraft, saveDraft } from "../drafts/store";
import type { Draft } from "../drafts/types";
import { claimNonce } from "./nonces";

/**
 * How stale a signature may be. Long enough to survive a slow upload and clock
 * skew between GitHub and Cloudflare, short enough that a captured request is
 * useless by the time anyone could use it.
 */
const MAX_AGE_MS = 5 * 60 * 1000;

export interface CallbackEnv extends PublishEnv, TelegramApiEnv {
  PRIVATE_BUCKET: R2Bucket;
  CALLBACK_HMAC_SECRET: string;
  MEDIA_BASE_URL: string;
  SITE_BASE_URL: string;
}

interface CallbackMedia {
  sourceId: string;
  type: "image" | "video";
  src: string;
  thumbnail?: string;
  poster?: string;
  width?: number;
  height?: number;
}

interface CallbackBody {
  draftId: string;
  jobId: string;
  processedAt: string;
  media: CallbackMedia[];
}

/** Terse and uniform. A caller that failed a check learns that it failed, not which one. */
function refuse(status: number): Response {
  return new Response(status === 401 ? "Unauthorized" : "Bad request", { status });
}

function parseBody(raw: string): CallbackBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const body = parsed as CallbackBody;

  if (typeof body.draftId !== "string" || typeof body.jobId !== "string") return null;
  if (!Array.isArray(body.media)) return null;

  return body;
}

export async function handleMediaProcessed(request: Request, env: CallbackEnv): Promise<Response> {
  if (!env.CALLBACK_HMAC_SECRET) {
    // Fail closed, and say so once: an unconfigured secret means every callback
    // is refused, which is otherwise a mystifying 401.
    // Keep this visible to a live tail without allowing arbitrary callers to
    // create a durable error-log object for every request.
    console.warn("CALLBACK_HMAC_SECRET is not configured; refusing every callback");
    return refuse(401);
  }

  const timestamp = request.headers.get("X-Callback-Timestamp");
  const nonce = request.headers.get("X-Callback-Nonce");
  const signature = request.headers.get("X-Callback-Signature");
  if (!timestamp || !nonce || !signature) return refuse(401);

  // 1. Timestamp is recent. Checked before the signature so an ancient replay
  //    costs nothing to reject.
  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > MAX_AGE_MS) return refuse(401);

  const raw = await request.text();

  // 2 and 3. Signature matches, compared in constant time.
  const expected = await hmacSha256Hex(env.CALLBACK_HMAC_SECRET, `${timestamp}.${nonce}.${raw}`);
  if (!timingSafeEqual(signature, expected)) return refuse(401);

  // 4. Nonce was not used. Only now, so an unauthenticated caller cannot burn
  //    nonces, and only once, because claiming is what spends it.
  if (!(await claimNonce(env.PRIVATE_BUCKET, nonce))) return refuse(401);

  const body = parseBody(raw);
  if (body === null) return refuse(400);

  // 5. Draft exists.
  const draft = await loadDraft(env.PRIVATE_BUCKET, body.draftId);
  if (draft === null) return refuse(400);

  // 10. Not already completed. Ahead of the state check so a repeat returns the
  //     result rather than a refusal — spec §13.4 asks for exactly that.
  if (draft.published !== null) {
    return Response.json({ status: "already-published", url: draft.published.url });
  }

  // 6. Draft is in processing.
  if (draft.state !== "processing") return refuse(400);

  // 7. Job id matches the one dispatched. This is the token minted at dispatch
  //    rather than the run id from the spec's example: the run id is public and
  //    guessable, and this check exists to bind a callback to its dispatch.
  if (draft.job === null || !timingSafeEqual(body.jobId, draft.job.jobToken)) return refuse(400);

  // 8. Media ids match the originals this draft actually holds.
  const known = new Set(draft.originals.map((original) => original.mediaId));
  if (body.media.length === 0 || !body.media.every((item) => known.has(item.sourceId))) return refuse(400);

  // 9. Every URL is on the configured media domain. A signed callback naming
  //    another host would otherwise publish someone else's images on her site.
  const prefix = `${env.MEDIA_BASE_URL.replace(/\/$/, "")}/`;
  const urls = body.media.flatMap((item) => [item.src, item.thumbnail, item.poster].filter(Boolean) as string[]);
  if (!urls.every((url) => url.startsWith(prefix))) return refuse(400);

  return publishProcessed(env, draft, body);
}

async function publishProcessed(env: CallbackEnv, draft: Draft, body: CallbackBody): Promise<Response> {
  if (draft.record === null) return refuse(400);

  const media: PublicMedia[] = body.media.map((item) => {
    // Alt and caption come from the draft, not the callback: they are the
    // author's approved words, and Actions has no business changing them.
    const described = draft.record?.media.find((entry) => entry.mediaId === item.sourceId);
    return {
      type: item.type,
      src: item.src,
      ...(item.thumbnail ? { thumbnail: item.thumbnail } : {}),
      ...(item.poster ? { poster: item.poster } : {}),
      alt: described?.alt ?? null,
      caption: described?.caption ?? null,
    };
  });

  const result = await publishRecord(env, { ...toPublicRecord(draft.record), media });

  if (result.status !== "published") {
    // The draft stays in processing: the retry flow works from there, and the
    // nonce is spent, so a retry will carry a fresh one.
    console.error(`Could not publish the processed record: ${result.reason}`);
    return new Response("Publication failed", { status: 500 });
  }

  const url = `${env.SITE_BASE_URL.replace(/\/$/, "")}/#activity`;
  const published: Draft = {
    ...transition(draft, "published"),
    preview: null,
    published: { recordId: result.record.id, url },
    updatedAt: new Date().toISOString(),
  };

  try {
    await saveDraft(env.PRIVATE_BUCKET, published);
  } catch {
    // The record is live; only the bookkeeping failed. Saying so would alarm
    // the author about something that no longer affects them, but a repeat
    // callback would now republish, which is why this is logged loudly.
    console.error("Published the processed record but could not record it on the draft");
  }

  await sendMessage(env, draft.source.chatId, `Published. ${url}`);

  return Response.json({ status: "published", url });
}
