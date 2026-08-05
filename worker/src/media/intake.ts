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
import { storeOriginal, type OriginalRequest, type OriginalsEnv } from "./originals";

export interface MediaIntakeEnv extends OriginalsEnv {
  PRIVATE_BUCKET: R2Bucket;
}

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

/** Null when the message carries nothing this handles. */
export function mediaRequest(message: TelegramMessage): OriginalRequest | null {
  return largestPhoto(message) ?? videoRequest(message);
}

export type MediaIntakeResult =
  | { status: "started"; draft: Draft }
  | { status: "appended"; draft: Draft }
  | { status: "unsupported" };

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
  const request = mediaRequest(message);
  if (request === null) return { status: "unsupported" };

  const groupId = message.media_group_id ?? null;

  // A later item of an album already has a draft; find it before making another.
  if (groupId !== null) {
    const existingId = await findAlbumDraft(env.PRIVATE_BUCKET, groupId);
    if (existingId !== null) {
      const existing = await loadDraft(env.PRIVATE_BUCKET, existingId);
      if (existing !== null && existing.state === "draft") {
        return { status: "appended", draft: await appendOriginal(env, existing, request) };
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

  return { status: "started", draft: await appendOriginal(env, draft, request) };
}

async function appendOriginal(
  env: MediaIntakeEnv,
  draft: Draft,
  request: OriginalRequest,
): Promise<Draft> {
  const stored = await storeOriginal(env, draft.activityId, request);

  // One unreadable file costs that file, not the draft. The author still gets a
  // preview of whatever did arrive.
  if (stored === null) return draft;

  const originals: DraftOriginal[] = [...draft.originals, stored];
  const updated: Draft = { ...draft, originals, updatedAt: new Date().toISOString() };

  try {
    await saveDraft(env.PRIVATE_BUCKET, updated);
  } catch {
    console.error("Stored an original but could not record it on the draft");
    return draft;
  }

  return updated;
}
