/**
 * A picture or clip uploaded from the article editor, on its way through the
 * sanitiser. A picture goes into the text or the carousel; a clip only ever
 * into the carousel, since the text has nowhere to play one.
 *
 * The Worker still never writes the media bucket. A picture from the editor
 * takes the road every Telegram photo takes — the private bucket, a GitHub
 * Actions run that strips its metadata and makes the derivatives, a signed
 * callback — and only the two ends differ: the bytes arrive in a request body
 * rather than from Telegram, and the callback stops at recording the URLs
 * (callbacks/media-processed.ts) instead of publishing. The editor page polls
 * for them and puts the picture into the text when they exist.
 *
 * One draft per picture. A picture finishing does not wait on the others, and a
 * failed one fails alone.
 */
import { DRAFT_SCHEMA_VERSION, type Draft } from "../drafts/types";
import { loadDraft, saveDraft } from "../drafts/store";
import { randomId } from "../ids";
import { sniff, SNIFF_BYTES } from "../media/formats";
import { MAX_DOWNLOAD_BYTES, originalKey } from "../media/originals";
import { dispatchMediaProcessing, newJobToken, type DispatchEnv } from "../publishing/dispatch";
import type { EditorKey } from "./keys";

export interface EditorMediaEnv extends DispatchEnv {
  PRIVATE_BUCKET: R2Bucket;
}

/** The same ceiling a Telegram file has, so the sanitiser never sees a bigger one from here. */
export const MAX_UPLOAD_BYTES = MAX_DOWNLOAD_BYTES;

export type UploadResult =
  | { status: "uploaded"; uploadId: string }
  | { status: "too-large" }
  | { status: "length-required" }
  | { status: "unsupported"; label: string | null }
  | { status: "unavailable" };

/**
 * Checks the bytes, files them privately and starts the sanitiser.
 *
 * Buffered rather than streamed for the reason storeOriginal gives: the format
 * is read from the first bytes, and nothing is written until it has been.
 */
export async function uploadMedia(
  env: EditorMediaEnv,
  key: EditorKey,
  keyHash: string,
  request: Request,
  now: Date = new Date(),
): Promise<UploadResult> {
  // Required rather than trusted when present: a browser always sends it for a
  // file, and without it the body below would be read whole before its size
  // could be refused — inside an isolate with 128 MB to spend.
  const declared = Number(request.headers.get("content-length") ?? "");
  if (!Number.isFinite(declared) || declared <= 0) return { status: "length-required" };
  if (declared > MAX_UPLOAD_BYTES) return { status: "too-large" };

  let buffer: ArrayBuffer;
  try {
    buffer = await request.arrayBuffer();
  } catch {
    return { status: "unavailable" };
  }
  if (buffer.byteLength > MAX_UPLOAD_BYTES) return { status: "too-large" };

  const format = sniff(new Uint8Array(buffer, 0, Math.min(SNIFF_BYTES, buffer.byteLength)));
  // Whatever the sanitiser can open: the same formats a Telegram message may
  // carry. Where it may go — text or carousel — is the publish route's check.
  if (format === null || !format.open) {
    return { status: "unsupported", label: format?.label ?? null };
  }

  const mediaId = randomId();
  const objectKey = originalKey(key.activityId, mediaId, format.extension);
  const timestamp = now.toISOString();
  const job = { jobToken: newJobToken(), dispatchedAt: timestamp };

  const draft: Draft = {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    draftId: randomId(),
    state: "processing",
    createdAt: timestamp,
    updatedAt: timestamp,
    // No Telegram message started this. The chat is the key's, so the sweep's
    // report on a picture that never came back reaches the right person.
    source: { chatId: key.chatId, senderId: 0, messageId: 0 },
    activityId: key.activityId,
    mediaGroupId: null,
    originals: [{ mediaId, type: format.kind, fileId: "", key: objectKey, bytes: buffer.byteLength }],
    mediaDeclined: false,
    input: { text: "" },
    record: null,
    attachment: null,
    preview: null,
    published: null,
    job,
    processed: null,
    editor: { keyHash },
  };

  try {
    await env.PRIVATE_BUCKET.put(objectKey, buffer);
    await saveDraft(env.PRIVATE_BUCKET, draft);
  } catch {
    console.error("Could not store an editor upload in the private bucket");
    return { status: "unavailable" };
  }

  if (!(await dispatchMediaProcessing(env, draft.draftId, job.jobToken))) {
    await saveDraft(env.PRIVATE_BUCKET, { ...draft, state: "failed", updatedAt: new Date().toISOString() }).catch(
      () => undefined,
    );
    return { status: "unavailable" };
  }

  return { status: "uploaded", uploadId: draft.draftId };
}

export type UploadStatus =
  | { status: "processing" }
  | {
      status: "ready";
      type: "image" | "video";
      src: string;
      thumbnail?: string;
      poster?: string;
      /** What a clip's transcode visibly changed, in words for the author. Empty for a picture. */
      changes: string[];
    }
  | { status: "failed" }
  | { status: "unknown" };

/** Where an upload made with this key has got to. Another key's upload is "unknown". */
export async function uploadStatus(
  env: EditorMediaEnv,
  keyHash: string,
  uploadId: string,
): Promise<UploadStatus> {
  const draft = await loadDraft(env.PRIVATE_BUCKET, uploadId);
  if (draft === null || (draft.editor ?? null)?.keyHash !== keyHash) return { status: "unknown" };

  if (draft.state === "processing") return { status: "processing" };
  const item = draft.processed?.media[0];
  if (draft.state === "published" && item?.src) {
    return {
      status: "ready",
      type: item.type,
      src: item.src,
      ...(item.thumbnail ? { thumbnail: item.thumbnail } : {}),
      ...(item.poster ? { poster: item.poster } : {}),
      changes: item.visibleChanges ?? [],
    };
  }
  return { status: "failed" };
}
