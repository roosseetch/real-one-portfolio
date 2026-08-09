/**
 * Moves an original photo or video from Telegram into the private bucket
 * (spec §7.1 step 4, §10.1).
 *
 * Originals are the input to sanitisation, so they carry everything the
 * published file must not: EXIF, GPS, camera identifiers, timestamps. They live
 * only in the private bucket, under the seven-day lifecycle rule, and nothing
 * public is created until the media pipeline has stripped them.
 */
import { randomId } from "../ids";
import type { TelegramApiEnv } from "../telegram/api";
import type { DraftOriginal } from "../drafts/types";
import { sniff, SNIFF_BYTES, type FormatEntry } from "./formats";

const API_BASE = "https://api.telegram.org";

/**
 * The Bot API refuses to hand over anything larger. Worth naming, because the
 * failure is otherwise a bare 400 from getFile and the author would have no
 * idea why a video vanished.
 */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export interface OriginalRequest {
  type: "image" | "video";
  fileId: string;
  width?: number;
  height?: number;
  bytes?: number;
}

export interface OriginalsEnv extends TelegramApiEnv {
  PRIVATE_BUCKET: R2Bucket;
}

export function originalKey(activityId: string, mediaId: string, extension: string): string {
  return `originals/${activityId}/${mediaId}.${extension}`;
}

/**
 * Telegram's own path usually carries the extension; the format the bytes turn
 * out to be is the fallback.
 *
 * Nothing downstream reads it — the sanitiser opens by content — so this is only about
 * the private bucket describing itself honestly. It used to guess `jpg` or
 * `mp4` from the requested type, which is exactly the kind of small lie that
 * costs an hour when something later goes wrong.
 */
function extensionOf(path: string, format: FormatEntry): string {
  const match = /\.([a-z0-9]{2,4})$/i.exec(path);
  return match ? match[1].toLowerCase() : format.extension;
}

interface FileInfo {
  file_path?: string;
  file_size?: number;
}

/**
 * Why a file did not become an original.
 *
 * `null` used to cover both of these, and that is why a dropped file was
 * invisible: a transport failure is nobody's fault and worth retrying, whereas
 * a file whose contents are not what its name claimed is something the author
 * needs to be told about. Only a distinguishable result lets the caller say so.
 */
export type StoreResult =
  | { status: "stored"; original: DraftOriginal }
  | { status: "wrong-format"; label: string | null }
  /**
   * Past the ceiling below, so the bytes could never have been fetched. Split
   * out from `unavailable` because it is the one refusal that is neither a
   * transport failure nor retryable: the author has to send a smaller file, and
   * cannot know that unless told.
   */
  | { status: "too-large"; bytes: number; limit: number }
  | { status: "unavailable" };

/**
 * Downloads one file, checks it really is what it claimed, and stores it
 * privately.
 *
 * Never throws: one unreadable photo in an album should cost that photo, not
 * the whole draft, and the author still gets a preview of what did arrive.
 *
 * The download is buffered rather than streamed into R2, and the reason is
 * ordering rather than convenience. The signature cannot be read until some
 * bytes have arrived, and with a stream R2 has already accepted them by then —
 * so rejecting a file would mean deleting a partial object, in the one place
 * the system promises nothing exists until sanitisation has run. Buffering
 * makes "verify, then write" structural. The allocation is bounded by
 * MAX_DOWNLOAD_BYTES, which is checked twice below and is the only thing
 * keeping this well inside the isolate's memory.
 */
export async function storeOriginal(
  env: OriginalsEnv,
  activityId: string,
  request: OriginalRequest,
): Promise<StoreResult> {
  if (request.bytes !== undefined && request.bytes > MAX_DOWNLOAD_BYTES) {
    console.warn(`Original too large for the Bot API to serve: ${request.bytes} bytes`);
    return { status: "too-large", bytes: request.bytes, limit: MAX_DOWNLOAD_BYTES };
  }

  let info: FileInfo;
  try {
    const response = await fetch(`${API_BASE}/bot${env.TELEGRAM_BOT_TOKEN}/getFile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_id: request.fileId }),
    });
    const payload = (await response.json()) as { ok: boolean; result?: FileInfo };
    if (!response.ok || !payload.ok || !payload.result?.file_path) {
      console.warn(`Telegram getFile did not return a path (status ${response.status})`);
      return { status: "unavailable" };
    }
    info = payload.result;
  } catch {
    console.warn("Telegram getFile could not be reached");
    return { status: "unavailable" };
  }

  // A document arrives with no file_size of its own — the case that started all
  // of this — so the check above can be skipped entirely. getFile always
  // reports one, and it is the last chance to refuse before the bytes are held
  // in memory.
  if (info.file_size !== undefined && info.file_size > MAX_DOWNLOAD_BYTES) {
    console.warn(`Original too large to buffer: ${info.file_size} bytes`);
    return { status: "too-large", bytes: info.file_size, limit: MAX_DOWNLOAD_BYTES };
  }

  let buffer: ArrayBuffer;
  try {
    // The download URL embeds the bot token, so it is built here and never
    // logged, returned, or stored on the draft.
    const file = await fetch(`${API_BASE}/file/bot${env.TELEGRAM_BOT_TOKEN}/${info.file_path}`);
    if (!file.ok) {
      console.warn(`Could not download the original (status ${file.status})`);
      return { status: "unavailable" };
    }
    buffer = await file.arrayBuffer();
  } catch {
    console.warn("Could not download the original");
    return { status: "unavailable" };
  }

  const format = sniff(new Uint8Array(buffer, 0, Math.min(SNIFF_BYTES, buffer.byteLength)));

  if (format === null || !format.open) {
    // console.error, not warn: flush() keeps warnings only as context around an
    // error, so a warning here would leave a refusal with no durable trace —
    // which is the condition that made the original report unreconstructable.
    console.error(`Refused an original whose contents are ${format?.label ?? "not a format we publish"}`);
    return { status: "wrong-format", label: format?.label ?? null };
  }

  // The bytes outrank the claim. A video filed as an image is not a cosmetic
  // mistake: the media workflow selects on `type == "image"`, so the sanitiser
  // would hand an mp4 to a picture decoder and the run would fail with nothing
  // said to anyone.
  if (format.kind !== request.type) {
    console.warn(`Filed as ${format.kind} rather than ${request.type}: the bytes are a ${format.label}`);
  }

  const mediaId = randomId();
  const key = originalKey(activityId, mediaId, extensionOf(info.file_path ?? "", format));

  try {
    await env.PRIVATE_BUCKET.put(key, buffer);
  } catch {
    console.warn("Could not store the original in the private bucket");
    return { status: "unavailable" };
  }

  return {
    status: "stored",
    original: {
      mediaId,
      type: format.kind,
      fileId: request.fileId,
      key,
      width: request.width,
      height: request.height,
      bytes: request.bytes ?? info.file_size ?? buffer.byteLength,
    },
  };
}
