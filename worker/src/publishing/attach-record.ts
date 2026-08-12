/**
 * The last step of adding media to an activity that is already published.
 *
 * It stands where `publishProcessedMedia` stands on the ordinary path, and is
 * reached by the same two callers for the same two reasons: the callback lands
 * here when the transcode changed nothing visible, and the approval loop lands
 * here when the author has confirmed a video that it did. Everything before this
 * point — the private originals, the sanitisation in a GitHub Actions runner,
 * the signed callback — is not just similar to the publishing path, it *is* the
 * publishing path. Only the write at the end differs.
 */
import { activityUrl } from "../content/urls";
import type { PublicMedia, PublicRecord } from "../content/records";
import { transition } from "../drafts/state";
import { saveDraft } from "../drafts/store";
import type { Draft, ProcessedMedia } from "../drafts/types";
import { sendMessage, type TelegramApiEnv } from "../telegram/api";
import { amendRecord, type AmendEnv } from "./amend";

export interface AttachEnv extends AmendEnv, TelegramApiEnv {
  PRIVATE_BUCKET: R2Bucket;
  /** Where the amended activity is visible, for the link sent back to the author. */
  SITE_BASE_URL: string;
}

export type AttachResult = { status: "attached"; url: string } | { status: "failed" };

/** How the author is told, given how many files landed. */
function added(count: number): string {
  return count === 1 ? "Added the file to" : `Added the ${count} files to`;
}

/**
 * Appends the sanitised media to the target record and tells the author.
 *
 * Alt text and captions are null, exactly as they are on every record this
 * system has ever published: the model is never shown the media and never asked
 * to describe it, so there is nothing here to carry across. What matters is that
 * the shape is identical to what `publishProcessedMedia` writes, because the
 * site cannot tell — and must not be able to tell — an item that arrived with
 * the activity from one added to it afterwards.
 */
export async function attachProcessedMedia(
  env: AttachEnv,
  draft: Draft,
  media: ProcessedMedia[],
): Promise<AttachResult> {
  const recordId = draft.attachment?.recordId ?? null;
  if (recordId === null) return { status: "failed" };

  const additions: PublicMedia[] = media.map((item) => ({
    type: item.type,
    src: item.src,
    ...(item.thumbnail ? { thumbnail: item.thumbnail } : {}),
    ...(item.poster ? { poster: item.poster } : {}),
    alt: null,
    caption: null,
  }));

  const result = await amendRecord(env, recordId, (record) => appended(record, additions));

  if (result.status === "failed") {
    // The draft is left where it was, so the retry flow can run this again. The
    // media is already in the public bucket and unreferenced, which is the same
    // position a failed publication leaves it in.
    console.error(`Could not add the media to the activity: ${result.reason}`);
    return { status: "failed" };
  }

  const url = activityUrl(env.SITE_BASE_URL, result.record);
  const retired: Draft = {
    ...transition(draft, "published"),
    preview: null,
    published: { recordId: result.record.id, url },
    updatedAt: new Date().toISOString(),
  };

  try {
    await saveDraft(env.PRIVATE_BUCKET, retired);
  } catch {
    // The site is already showing them; only the bookkeeping failed. Saying so
    // would alarm the author about something that no longer affects them, but a
    // repeat callback would now add the same files twice, which is why this is
    // logged loudly.
    console.error("Added the media but could not record it on the draft");
  }

  await sendMessage(
    env,
    draft.source.chatId,
    `${added(additions.length)} "${result.record.title}". ${url}`,
  );

  return { status: "attached", url };
}

/**
 * The record with these items on the end, or the record itself if they are
 * already on it.
 *
 * Identity is what `amendRecord` reads as "nothing to do", and the `src` check
 * is what makes it possible: a callback delivered twice carries the same URLs,
 * and a chunk rewritten for it would put the same picture on the page twice.
 */
function appended(record: PublicRecord, additions: PublicMedia[]): PublicRecord {
  const present = new Set((record.media ?? []).map((item) => item.src));
  const missing = additions.filter((item) => !present.has(item.src));
  if (missing.length === 0) return record;

  return { ...record, media: [...(record.media ?? []), ...missing] };
}
