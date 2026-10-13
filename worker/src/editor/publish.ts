/**
 * Publishing an article from the site's editor, new or changed.
 *
 * The article's text is a document (site/src/rich-doc.ts) stored as its own
 * object, written once under a fresh name and never edited — the same rule the
 * chunks live by. The record carries its name, the pictures the text places,
 * and a plain-text lead for everything that reads `body`: a listing card, a
 * link preview, a LinkedIn repost. The whole text is not in the record because
 * every chunk is downloaded by every visit to the feed.
 *
 * The record is written with the same two functions every other route uses:
 * publishRecord for a new one, amendRecord for a change. The document goes
 * first, so a failure leaves at worst an object nothing names.
 */
import {
  cleanDoc,
  docFigures,
  docKey,
  docLead,
  type RichDoc,
} from "../../../site/src/rich-doc";
import { CHUNK_CACHE_CONTROL } from "../content/chunks";
import { ALL_CHUNKS, findRecord } from "../content/recent";
import type { PublicMedia, PublicRecord } from "../content/records";
import { activityUrl } from "../content/urls";
import { randomId } from "../ids";
import { deletePublishedItem, locateMedia } from "../media/published";
import { amendRecord } from "../publishing/amend";
import { parseFieldValue } from "../publishing/edit-fields";
import { publishRecord } from "../publishing/publish";
import { sendMessage, type TelegramApiEnv } from "../telegram/api";
import { bindKey, type EditorKey, type EditorKeysEnv } from "./keys";

export interface EditorPublishEnv extends EditorKeysEnv, TelegramApiEnv {
  CONTENT_BUCKET: R2Bucket;
  MEDIA_BUCKET: R2Bucket;
  MEDIA_BASE_URL: string;
  SITE_BASE_URL: string;
}

/** What the editor sends. Every field is checked here; nothing is trusted for being from the page. */
export interface ArticleInput {
  title: string;
  summary: string | null;
  eventDate: string | null;
  tags: string[];
  doc: RichDoc;
}

export type PublishOutcome =
  | { status: "published"; url: string; recordId: string; created: boolean }
  | { status: "invalid"; problem: string }
  | { status: "gone" }
  | { status: "failed" };

/** The 320px derivative, which is what a listing's small cells show. */
function thumbnailOf(src: string): string | undefined {
  const match = /-(\d+)\.(webp|png|jpe?g)$/i.exec(src);
  if (!match) return undefined;
  return Number(match[1]) > 320 ? `${src.slice(0, match.index)}-320.${match[2]}` : src;
}

/** The fields, checked with the same rules a Telegram edit is held to. */
export function parseArticle(raw: unknown): { ok: true; input: Omit<ArticleInput, "doc">; doc: unknown } | { ok: false; problem: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, problem: "not an article" };
  const body = raw as Record<string, unknown>;

  const text = (value: unknown) => (typeof value === "string" ? value : "");

  const title = parseFieldValue("title", text(body.title));
  if (title.status === "rejected") return { ok: false, problem: title.reason };

  const optional = (field: "summary" | "eventDate", value: unknown) => {
    if (text(value).trim() === "") return { ok: true as const, value: null };
    const parsed = parseFieldValue(field, text(value));
    return parsed.status === "ok" ? { ok: true as const, value: parsed.value as string } : { ok: false as const, problem: parsed.reason };
  };
  const summary = optional("summary", body.summary);
  if (!summary.ok) return { ok: false, problem: summary.problem };
  const eventDate = optional("eventDate", body.eventDate);
  if (!eventDate.ok) return { ok: false, problem: eventDate.problem };

  let tags: string[] = [];
  const rawTags = Array.isArray(body.tags) ? body.tags.filter((tag) => typeof tag === "string").join(",") : "";
  if (rawTags.trim() !== "") {
    const parsed = parseFieldValue("tags", rawTags);
    if (parsed.status === "rejected") return { ok: false, problem: parsed.reason };
    tags = parsed.value as string[];
  }

  return {
    ok: true,
    input: { title: title.value as string, summary: summary.value, eventDate: eventDate.value, tags },
    doc: body.doc,
  };
}

/**
 * Publishes the article a key may write.
 *
 * `existing` is the live record for an update key, or for a create key that
 * has already published once; null means this publish creates the record.
 */
export async function publishArticle(
  env: EditorPublishEnv,
  key: EditorKey,
  keyHash: string,
  raw: unknown,
): Promise<PublishOutcome> {
  const parsed = parseArticle(raw);
  if (!parsed.ok) return { status: "invalid", problem: parsed.problem };

  let existing: PublicRecord | null = null;
  if (key.recordId !== null) {
    try {
      existing = await findRecord(env, key.recordId, ALL_CHUNKS);
    } catch {
      return { status: "failed" };
    }
    if (existing === null) return { status: "gone" };
  }

  // Pictures uploaded with this key, and the ones the article already had.
  const media = env.MEDIA_BASE_URL.replace(/\/$/, "");
  const folder = `${media}/media/activity-${key.activityId}/`;
  const kept = new Map((existing?.media ?? []).filter((item) => item.type === "image").map((item) => [item.src, item]));
  const cleaned = cleanDoc(parsed.doc, { allowSrc: (src) => src.startsWith(folder) || kept.has(src) });
  if (!cleaned.ok) return { status: "invalid", problem: cleaned.problem };
  const doc = cleaned.doc;

  const figures = docFigures(doc);
  const seen = new Set<string>();
  const pictures: PublicMedia[] = [];
  for (const figure of figures) {
    if (seen.has(figure.src)) continue;
    seen.add(figure.src);
    const before = kept.get(figure.src);
    const thumbnail = before?.thumbnail ?? thumbnailOf(figure.src);
    pictures.push({
      type: "image",
      src: figure.src,
      ...(thumbnail ? { thumbnail } : {}),
      alt: figure.alt,
      caption: figure.caption,
    });
  }

  const recordId = existing?.id ?? key.activityId;
  const docId = randomId(12);
  try {
    await env.CONTENT_BUCKET.put(docKey(recordId, docId), JSON.stringify(doc), {
      httpMetadata: { contentType: "application/json", cacheControl: CHUNK_CACHE_CONTROL },
    });
  } catch {
    console.error("Could not write an article's document; nothing was published");
    return { status: "failed" };
  }

  // A video cannot sit in the text, so an article opened for an update keeps
  // the ones it had, after its pictures, where the page shows them in the
  // carousel under the article.
  const videos = (existing?.media ?? []).filter((item) => item.type === "video");

  const fields = {
    ...parsed.input,
    body: docLead(doc) || null,
    media: [...pictures, ...videos],
    bodyFormat: "rich" as const,
    doc: docId,
  };

  let record: PublicRecord;
  if (existing === null) {
    const result = await publishRecord(env, {
      id: recordId,
      ...fields,
      publishedAt: new Date().toISOString(),
    });
    if (result.status !== "published") return { status: "failed" };
    record = result.record;
    try {
      await bindKey(env, keyHash, key, record.id);
    } catch {
      // The article is live; only the binding failed. The next Publish with
      // this link would then post a second copy, so this is worth a loud line.
      console.error("Published from a create key but could not bind the key to the record");
    }
  } else {
    // Applied to whatever the record says now, keeping what this page does not
    // edit (publishedAt above all, which orders the feed).
    const result = await amendRecord(env, existing.id, (live) => ({ ...live, ...fields }));
    if (result.status === "failed") return result.reason === "not-found" ? { status: "gone" } : { status: "failed" };
    record = result.record;

    // Pictures the article no longer shows, each by its own media id, so a
    // picture still in the text is never caught by a folder-wide delete. They
    // are unreferenced from this moment, which is what makes deleting safe.
    for (const item of existing.media ?? []) {
      if (item.type !== "image" || seen.has(item.src)) continue;
      const location = locateMedia(item.src);
      if (location) await deletePublishedItem(env.MEDIA_BUCKET, location);
    }
  }

  const url = activityUrl(env.SITE_BASE_URL, record);
  await sendMessage(
    env,
    key.chatId,
    existing === null ? `Published "${record.title}".\n${url}` : `Updated "${record.title}".\n${url}`,
  );
  return { status: "published", url, recordId: record.id, created: existing === null };
}
