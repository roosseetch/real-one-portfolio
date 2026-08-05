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

/** Telegram's own path carries the extension; anything unrecognised is stored as .bin rather than guessed at. */
function extensionOf(path: string, type: "image" | "video"): string {
  const match = /\.([a-z0-9]{2,4})$/i.exec(path);
  if (match) return match[1].toLowerCase();
  return type === "image" ? "jpg" : "mp4";
}

interface FileInfo {
  file_path?: string;
  file_size?: number;
}

/**
 * Downloads one file and stores it privately.
 *
 * Returns null rather than throwing: one unreadable photo in an album should
 * cost that photo, not the whole draft, and the author still gets a preview of
 * what did arrive.
 */
export async function storeOriginal(
  env: OriginalsEnv,
  activityId: string,
  request: OriginalRequest,
): Promise<DraftOriginal | null> {
  if (request.bytes !== undefined && request.bytes > MAX_DOWNLOAD_BYTES) {
    console.warn(`Original too large for the Bot API to serve: ${request.bytes} bytes`);
    return null;
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
      return null;
    }
    info = payload.result;
  } catch {
    console.warn("Telegram getFile could not be reached");
    return null;
  }

  const mediaId = randomId();
  const extension = extensionOf(info.file_path ?? "", request.type);
  const key = originalKey(activityId, mediaId, extension);

  try {
    // The download URL embeds the bot token, so it is built here and never
    // logged, returned, or stored on the draft.
    const file = await fetch(`${API_BASE}/file/bot${env.TELEGRAM_BOT_TOKEN}/${info.file_path}`);
    if (!file.ok || file.body === null) {
      console.warn(`Could not download the original (status ${file.status})`);
      return null;
    }

    await env.PRIVATE_BUCKET.put(key, file.body);
  } catch {
    console.warn("Could not store the original in the private bucket");
    return null;
  }

  return {
    mediaId,
    type: request.type,
    fileId: request.fileId,
    key,
    width: request.width,
    height: request.height,
    bytes: request.bytes ?? info.file_size,
  };
}
