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
import { timingSafeEqual } from "../crypto";
import { randomId } from "../ids";
import { attachProcessedMedia, type AttachEnv } from "../publishing/attach-record";
import { publishProcessedMedia, type MediaPublishEnv } from "../publishing/media-record";
import { sendMediaGroup, sendMessage, type TelegramApiEnv } from "../telegram/api";
import { confirmationKeyboard, formatMediaConfirmation } from "../telegram/preview";
import { transition } from "../drafts/state";
import { loadDraft, saveDraft } from "../drafts/store";
import type { Draft, ProcessedMedia } from "../drafts/types";
import { readSignedCallback, refuse, type SignedCallbackEnv } from "./signature";

/** Matches the approval loop's preview tokens: unguessable inside 64 bytes of callback_data. */
const CONFIRMATION_TOKEN_LENGTH = 12;

export interface CallbackEnv extends MediaPublishEnv, AttachEnv, TelegramApiEnv, SignedCallbackEnv {
  PRIVATE_BUCKET: R2Bucket;
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
  /** Normalised on the way in; see `acceptableChanges`. */
  visibleChanges: string[];
}

interface CallbackBody {
  draftId: string;
  jobId: string;
  processedAt: string;
  media: CallbackMedia[];
}

/**
 * How much of the pipeline's account of a transcode is repeated to the author.
 *
 * The body is signed, so this is not a trust boundary in the usual sense — but
 * these strings are put in front of a person, and an unbounded list from a
 * process running third-party actions is worth clamping on the way past.
 */
const MAX_CHANGES = 5;
const MAX_CHANGE_LENGTH = 120;

function acceptableChanges(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    .slice(0, MAX_CHANGES)
    .map((entry) =>
      entry.length <= MAX_CHANGE_LENGTH ? entry : `${entry.slice(0, MAX_CHANGE_LENGTH - 1)}…`,
    );
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

  return {
    ...body,
    media: body.media.map((item) => ({
      ...item,
      visibleChanges: acceptableChanges((item as { visibleChanges?: unknown }).visibleChanges),
    })),
  };
}

export async function handleMediaProcessed(request: Request, env: CallbackEnv): Promise<Response> {
  // 1 to 4. Timestamp, signature and single-use nonce.
  const signed = await readSignedCallback(request, env);
  if (signed.status !== "verified") return refuse(401);

  const body = parseBody(signed.raw);
  if (body === null) return refuse(400);

  // 5. Draft exists.
  const draft = await loadDraft(env.PRIVATE_BUCKET, body.draftId);
  if (draft === null) return refuse(400);

  // 10. Not already completed. Ahead of the state check so a repeat returns the
  //     result rather than a refusal — spec §13.4 asks for exactly that.
  if (draft.published !== null) {
    return Response.json({ status: "already-published", url: draft.published.url });
  }

  // 7. Job id matches the one dispatched. This is the token minted at dispatch
  //    rather than the run id from the spec's example: the run id is public and
  //    guessable, and this check exists to bind a callback to its dispatch.
  //    Ahead of the state check, so the repeat below cannot be forged.
  if (draft.job === null || !timingSafeEqual(body.jobId, draft.job.jobToken)) return refuse(400);

  // A repeat of a callback that has already been accepted, for a draft now
  // waiting on the author's final look. Answered rather than refused, for the
  // same reason as the published case above: the job did its work, and a 400
  // would fail a run that was right.
  if (draft.state === "awaiting_approval" && (draft.processed ?? null) !== null) {
    return Response.json({ status: "awaiting-confirmation" });
  }

  // 6. Draft is in processing.
  if (draft.state !== "processing") return refuse(400);

  // 8. Media ids match the originals this draft actually holds. This is an
  //    exact one-to-one match: accepting a subset would silently drop an
  //    approved picture, while accepting a duplicate could publish it twice.
  const originals = new Map(draft.originals.map((original) => [original.mediaId, original]));
  const received = new Set(body.media.map((item) => item.sourceId));
  if (
    body.media.length === 0 ||
    body.media.length !== originals.size ||
    received.size !== body.media.length ||
    !body.media.every((item) => originals.get(item.sourceId)?.type === item.type)
  ) {
    return refuse(400);
  }

  // 9. Every URL is on the configured media domain. A signed callback naming
  //    another host would otherwise publish someone else's images on her site.
  const prefix = `${env.MEDIA_BASE_URL.replace(/\/$/, "")}/`;
  const urls = body.media.flatMap((item) => [item.src, item.thumbnail, item.poster].filter(Boolean) as string[]);
  if (!urls.every((url) => url.startsWith(prefix))) return refuse(400);

  // An attachment carries no record — the words are already on the site, and
  // this draft exists only to put files beside them — so the two are told apart
  // here rather than one of them being refused for looking like the other.
  const attachment = draft.attachment ?? null;
  if (attachment === null && draft.record === null) return refuse(400);
  // Nothing names an activity to amend, so there is nowhere for these files to
  // go. The author never confirmed a target, which means nothing dispatched
  // this — a callback that reaches here is describing work nobody asked for.
  if (attachment !== null && attachment.recordId === null) return refuse(400);

  const media: ProcessedMedia[] = body.media.map((item) => ({
    sourceId: item.sourceId,
    type: item.type,
    src: item.src,
    ...(item.thumbnail ? { thumbnail: item.thumbnail } : {}),
    ...(item.poster ? { poster: item.poster } : {}),
    visibleChanges: item.visibleChanges,
  }));

  // Spec Phase 6: a transcode that changed the clip visibly goes back for a
  // final look; anything else publishes the way a photo does. The sanitiser is
  // the only thing that ever holds both the original and the output, so what
  // counts as visible was decided there and only reported here.
  const changed = changedVideos(media);
  if (changed.length > 0) {
    return holdForConfirmation(env, draft, media, changed);
  }

  if (attachment !== null) {
    const attached = await attachProcessedMedia(env, draft, media);

    if (attached.status !== "attached") {
      // Same as below: the draft stays in processing so the retry flow can work
      // from there, and the spent nonce means a retry carries a fresh one.
      return new Response("Amendment failed", { status: 500 });
    }

    return Response.json({ status: "attached", url: attached.url });
  }

  const result = await publishProcessedMedia(env, draft, media);

  if (result.status !== "published") {
    // The draft stays in processing: the retry flow works from there, and the
    // nonce is spent, so a retry will carry a fresh one.
    return new Response("Publication failed", { status: 500 });
  }

  return Response.json({ status: "published", url: result.url });
}

/**
 * Shows the author what the transcode produced and waits for a decision.
 *
 * The draft goes back to `awaiting_approval` carrying the processed media, which
 * is what the approval loop then publishes from — the work is done and paid for,
 * and asking for it again would produce a second set of files.
 *
 * Answers 200 either way. The job sanitised, uploaded and reported correctly;
 * whether a person has looked at the result yet is not something a workflow run
 * can be marked failed over.
 */
/**
 * The items worth asking about: only a video is transcoded, so only a video can
 * have been changed by one. A picture arriving with a claim is a pipeline that
 * has changed under us rather than a question to put to the author.
 */
function changedVideos(media: ProcessedMedia[]): ProcessedMedia[] {
  return media.filter((item) => item.type === "video" && item.visibleChanges.length > 0);
}

async function holdForConfirmation(
  env: CallbackEnv,
  draft: Draft,
  media: ProcessedMedia[],
  changed: ProcessedMedia[],
): Promise<Response> {
  const token = randomId(CONFIRMATION_TOKEN_LENGTH);
  const waiting: Draft = {
    ...transition(draft, "awaiting_approval"),
    processed: { media, at: new Date().toISOString() },
  };

  try {
    await saveDraft(env.PRIVATE_BUCKET, waiting);
  } catch {
    // Nothing was published and nothing was recorded, so the draft is still in
    // `processing` and the retry flow can pick it up. Telling the author the
    // clip is ready would be worse: there would be no live button to act on.
    console.error("Could not hold the processed draft for confirmation");
    return new Response("Could not record the processed media", { status: 500 });
  }

  // By URL, which Telegram fetches itself. It refuses anything over 20 MB that
  // way, which is why the message below repeats every link: a refused fetch
  // must still leave the author able to watch what they are approving.
  await sendMediaGroup(
    env,
    draft.source.chatId,
    changed.map((item) => ({ type: "video", media: item.src })),
  );

  const messageId = await sendMessage(
    env,
    draft.source.chatId,
    formatMediaConfirmation(changed),
    confirmationKeyboard(draft.draftId, token),
  );

  if (messageId === null) {
    // The draft is held and its media is safe; only the question failed to
    // arrive. Left in `awaiting_approval` with no live preview, which is a
    // state the retry flow can resend from rather than one that republishes.
    console.error("Could not ask the author to confirm the processed media");
    return Response.json({ status: "awaiting-confirmation" });
  }

  try {
    await saveDraft(env.PRIVATE_BUCKET, {
      ...waiting,
      preview: { messageId, token },
      updatedAt: new Date().toISOString(),
    });
  } catch {
    // The buttons are on screen carrying a token that was never stored, so they
    // will be refused as superseded rather than publish anything.
    console.error("Could not record the confirmation token; its buttons will not work");
  }

  return Response.json({ status: "awaiting-confirmation" });
}
