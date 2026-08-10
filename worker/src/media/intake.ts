/**
 * Turns a photo or video message into originals on an existing or new draft
 * (spec §7.1 steps 2–4, §10.1).
 *
 * Nothing public is created here. The files go to the private bucket and the
 * preview re-sends them by Telegram file reference, so no public object exists
 * until the media pipeline has stripped the metadata off them.
 */
import { findAlbumDraft, rememberAlbum } from "../drafts/albums";
import { createDraft, loadDraft, saveDraft } from "../drafts/store";
import type { Draft, DraftOriginal } from "../drafts/types";
import type { TelegramMessage } from "../telegram/types";
import { classifyFile, type FileLabel, type MediaKind } from "./formats";
import { storeOriginal, type OriginalRequest, type OriginalsEnv } from "./originals";

export interface MediaIntakeEnv extends OriginalsEnv {
  PRIVATE_BUCKET: R2Bucket;
}

/**
 * Why a message's media cannot be published.
 *
 * Carried rather than turned into a sentence here: every word the author reads
 * lives in `drafts/intake.ts`, and a refusal that cannot say which of these it
 * was is how the first report of this bug arrived with nothing to go on.
 */
export type DeclineReason =
  /** Neither the declared type nor the file name names anything publishable. */
  | { kind: "not-media"; file: FileLabel }
  /** A real picture or video, with no decoder behind it. */
  | { kind: "unopenable"; mediaKind: MediaKind; format: string; file: FileLabel }
  | { kind: "sticker-moves"; video: boolean }
  /** The bytes disagreed with the name, found only after the download. */
  | { kind: "contents"; format: string | null; file: FileLabel }
  /**
   * Bigger than the Bot API will serve, so the bytes never arrived.
   *
   * No `FileLabel`: this reaches a `message.video`, which carries neither a mime
   * type nor a file name, so the note would read "no type at all" on the one
   * refusal that already knows exactly what happened and how big it was.
   */
  | { kind: "too-large"; mediaKind: MediaKind; bytes: number; limit: number };

export type MediaDecision =
  | { status: "accept"; request: OriginalRequest }
  | { status: "decline"; reason: DeclineReason }
  | { status: "none" };

/**
 * The largest rendition Telegram offers, which is last in the array.
 *
 * The smaller ones are Telegram's own downscales; keeping one would cap the
 * resolution every published derivative is generated from.
 */
export function largestPhoto(message: TelegramMessage): OriginalRequest | null {
  const sizes = message.photo;
  if (!Array.isArray(sizes) || sizes.length === 0) return null;

  const largest = sizes.reduce((best, size) =>
    (size.width ?? 0) * (size.height ?? 0) > (best.width ?? 0) * (best.height ?? 0) ? size : best,
  );

  return {
    type: "image",
    fileId: largest.file_id,
    width: largest.width,
    height: largest.height,
    bytes: largest.file_size,
  };
}

export function videoRequest(message: TelegramMessage): OriginalRequest | null {
  const video = message.video;
  if (!video?.file_id) return null;

  return {
    type: "video",
    fileId: video.file_id,
    width: video.width,
    height: video.height,
    bytes: video.file_size,
  };
}

/**
 * An image or video sent as a file.
 *
 * A document is an arbitrary file — a PDF, an archive, anything — whereas
 * Telegram guarantees `photo` is a picture, so accepting one unchecked would
 * hand the sanitiser something it cannot parse and turn a wrong attachment into
 * a failed pipeline run. Hence a gate; the trouble was that the gate used to be
 * the mime type alone. Telegram sends `.webp` as a document unprompted, and
 * when the client cannot name the type it sends none at all, or
 * `application/octet-stream` — and a picture was thrown away over it.
 *
 * So the claim is read twice, type first and file name second, and the bytes
 * settle it later in `storeOriginal`. Telegram reports no dimensions for a
 * document; the sanitiser reads them off the file itself.
 */
export function documentDecision(message: TelegramMessage): MediaDecision {
  const document = message.document;
  if (!document?.file_id) return { status: "none" };

  const file: FileLabel = { mime: document.mime_type ?? null, name: document.file_name ?? null };
  const verdict = classifyFile(file);

  if (verdict.status === "unknown") return { status: "decline", reason: { kind: "not-media", file } };
  if (verdict.status === "unopenable") {
    return {
      status: "decline",
      reason: { kind: "unopenable", mediaKind: verdict.kind, format: verdict.label, file },
    };
  }

  return {
    status: "accept",
    request: { type: verdict.kind, fileId: document.file_id, bytes: document.file_size },
  };
}

/**
 * A picture Telegram decided was a sticker.
 *
 * The author did nothing to ask for this: Telegram converts a `.webp` on the
 * way in, and the same file they meant to publish arrives under a field nothing
 * used to read. Unlike a document, a sticker comes with its dimensions.
 *
 * Animated and video stickers decline rather than return nothing, because
 * "nothing" is answered "I could not find anything to publish in that message",
 * which is not true and gives the author no way to work out what to do instead.
 */
export function stickerDecision(message: TelegramMessage): MediaDecision {
  const sticker = message.sticker;
  if (!sticker?.file_id) return { status: "none" };

  if (sticker.is_animated || sticker.is_video) {
    return { status: "decline", reason: { kind: "sticker-moves", video: sticker.is_video } };
  }

  return {
    status: "accept",
    request: {
      type: "image",
      fileId: sticker.file_id,
      width: sticker.width,
      height: sticker.height,
      bytes: sticker.file_size,
    },
  };
}

/**
 * What the message carries, in the order it is worth having.
 *
 * Photo and video win because Telegram guarantees both, so they can never
 * decline. A message never carries both a sticker and a document, so their
 * order relative to each other is arbitrary — but fixed here rather than left
 * to whichever branch happened to run first.
 */
export function mediaRequest(message: TelegramMessage): MediaDecision {
  const guaranteed = largestPhoto(message) ?? videoRequest(message);
  if (guaranteed !== null) return { status: "accept", request: guaranteed };

  const sticker = stickerDecision(message);
  if (sticker.status !== "none") return sticker;

  return documentDecision(message);
}

/**
 * Whether this is a message to route into the media path at all.
 *
 * Exported so the webhook's gate and the precedence chain above cannot list
 * different fields. They already did: `sticker` was in neither, and one of the
 * two forgetting a field is the shape of the bug this whole change is fixing.
 * The next kind to be added — `animation`, from Telegram's GIF picker — goes
 * here and in `mediaRequest`, and nowhere else.
 */
export function carriesMedia(message: TelegramMessage): boolean {
  return Boolean(message.photo || message.video || message.document || message.sticker);
}

export type MediaIntakeResult =
  /**
   * `declined` is the file *this* update carried, refused on its contents after
   * the draft already existed. The draft stands: one bad file in an album costs
   * that file, not the other three.
   */
  | { status: "started"; draft: Draft; declined: DeclineReason | null }
  | { status: "appended"; draft: Draft; declined: DeclineReason | null }
  /** Refused before anything was created, so no draft exists to clean up. */
  | { status: "declined"; reason: DeclineReason }
  | { status: "none" };

/**
 * Files the message's media against a draft, creating one if this is the first
 * item of an album, or of a single-photo message.
 *
 * Every album item that is not the first only appends: the preview belongs to
 * whoever created the draft, so the author gets one preview rather than one per
 * photo.
 */
export async function intakeMedia(
  message: TelegramMessage,
  senderId: number,
  env: MediaIntakeEnv,
): Promise<MediaIntakeResult> {
  const decision = mediaRequest(message);
  if (decision.status === "none") return { status: "none" };

  // Refused on the claim alone, so nothing has been downloaded and no draft has
  // been made. This is the cheap path, and the one that must stay cheap: it is
  // what stops a PDF from ever reaching the sanitiser.
  if (decision.status === "decline") return { status: "declined", reason: decision.reason };

  const request = decision.request;
  const file: FileLabel = {
    mime: message.document?.mime_type ?? null,
    name: message.document?.file_name ?? null,
  };
  const groupId = message.media_group_id ?? null;

  // A later item of an album already has a draft; find it before making another.
  if (groupId !== null) {
    const existingId = await findAlbumDraft(env.PRIVATE_BUCKET, groupId);
    if (existingId !== null) {
      const existing = await loadDraft(env.PRIVATE_BUCKET, existingId);
      if (existing !== null && existing.state === "draft") {
        const appended = await appendOriginal(env, existing, request, file);
        return { status: "appended", ...appended };
      }
    }
  }

  // A caption arrives instead of text when media is attached, and only the
  // first item of an album carries it.
  const caption = message.caption?.trim() ?? "";
  const draft = await createDraft(
    env.PRIVATE_BUCKET,
    { chatId: message.chat.id, senderId, messageId: message.message_id },
    caption,
    new Date(),
    groupId,
  );

  // Recorded before the download, which can take seconds: a sibling arriving
  // meanwhile must find this draft rather than start a second one.
  if (groupId !== null) await rememberAlbum(env.PRIVATE_BUCKET, groupId, draft.draftId);

  const started = await appendOriginal(env, draft, request, file);
  return { status: "started", ...started };
}

/**
 * Marks the draft as having lost a file, and persists it.
 *
 * Written rather than kept in memory because an album's siblings arrive as
 * separate updates and re-read the draft from R2: the item that was refused is
 * not the item that previews. A failed write costs the notice on the preview,
 * not the draft, so it is logged rather than raised.
 */
async function recordDecline(env: MediaIntakeEnv, draft: Draft): Promise<Draft> {
  if (draft.mediaDeclined) return draft;

  const marked: Draft = { ...draft, mediaDeclined: true, updatedAt: new Date().toISOString() };
  try {
    await saveDraft(env.PRIVATE_BUCKET, marked);
  } catch {
    console.error("Could not record that a file was refused; the preview will not mention it");
    return draft;
  }
  return marked;
}

async function appendOriginal(
  env: MediaIntakeEnv,
  draft: Draft,
  request: OriginalRequest,
  file: FileLabel,
): Promise<{ draft: Draft; declined: DeclineReason | null }> {
  const stored = await storeOriginal(env, draft.activityId, request);

  // One unreadable file costs that file, not the draft. The author still gets a
  // preview of whatever did arrive. What changed is that a file refused on its
  // contents now says so, rather than disappearing as quietly as a timeout.
  if (stored.status === "too-large") {
    return {
      draft: await recordDecline(env, draft),
      declined: {
        kind: "too-large",
        mediaKind: request.type,
        bytes: stored.bytes,
        limit: stored.limit,
      },
    };
  }
  // Reported to nobody — a timeout looks the same from here — but it is still a
  // file the author attached and this draft does not have.
  if (stored.status === "unavailable") return { draft: await recordDecline(env, draft), declined: null };
  if (stored.status === "wrong-format") {
    return {
      draft: await recordDecline(env, draft),
      declined: { kind: "contents", format: stored.label, file },
    };
  }

  const originals: DraftOriginal[] = [...draft.originals, stored.original];
  const updated: Draft = { ...draft, originals, updatedAt: new Date().toISOString() };

  try {
    await saveDraft(env.PRIVATE_BUCKET, updated);
  } catch {
    console.error("Stored an original but could not record it on the draft");
    return { draft, declined: null };
  }

  return { draft: updated, declined: null };
}
