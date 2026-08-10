/**
 * Publishing a record whose media has already been sanitised (spec §13.4).
 *
 * Two callers reach this, and they must not diverge: the media-processed
 * callback publishes straight away when the transcode changed nothing visible,
 * and the approval loop publishes from here when the author has confirmed a
 * video that it did change. Same chunk write, same manifest write, same message
 * — the only difference is how long the draft waited.
 */
import { toPublicRecord, type PublicMedia } from "../content/records";
import { transition } from "../drafts/state";
import { saveDraft } from "../drafts/store";
import type { Draft, ProcessedMedia } from "../drafts/types";
import { sendMessage, type TelegramApiEnv } from "../telegram/api";
import { publishRecord, type PublishEnv } from "./publish";

export interface MediaPublishEnv extends PublishEnv, TelegramApiEnv {
  PRIVATE_BUCKET: R2Bucket;
  /** Where the published record becomes visible, for the link sent back to the author. */
  SITE_BASE_URL: string;
}

export type MediaPublishResult = { status: "published"; url: string } | { status: "failed" };

/**
 * Writes the record, retires the draft, and tells the author where it is.
 *
 * Alt text and captions come from the draft rather than from the pipeline: they
 * are the author's approved words, and nothing outside Cloudflare has any
 * business changing them.
 */
export async function publishProcessedMedia(
  env: MediaPublishEnv,
  draft: Draft,
  media: ProcessedMedia[],
): Promise<MediaPublishResult> {
  if (draft.record === null) return { status: "failed" };

  const published: PublicMedia[] = media.map((item) => {
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

  const result = await publishRecord(env, { ...toPublicRecord(draft.record), media: published });

  if (result.status !== "published") {
    // The draft is left where it was: the retry flow works from there, and a
    // spent nonce means a retry carries a fresh one.
    console.error(`Could not publish the processed record: ${result.reason}`);
    return { status: "failed" };
  }

  const url = `${env.SITE_BASE_URL.replace(/\/$/, "")}/#activity`;
  const retired: Draft = {
    ...transition(draft, "published"),
    preview: null,
    published: { recordId: result.record.id, url },
    updatedAt: new Date().toISOString(),
  };

  try {
    await saveDraft(env.PRIVATE_BUCKET, retired);
  } catch {
    // The record is live; only the bookkeeping failed. Saying so would alarm the
    // author about something that no longer affects them, but a repeat callback
    // would now republish, which is why this is logged loudly.
    console.error("Published the processed record but could not record it on the draft");
  }

  await sendMessage(env, draft.source.chatId, `Published. ${url}`);
  return { status: "published", url };
}
