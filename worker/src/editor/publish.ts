/**
 * Publishing an article from the site's editor, new or changed.
 *
 * The article's text is a document (site/src/rich-doc.ts) stored as its own
 * object, written once under a fresh name and never edited — the same rule the
 * chunks live by. The record carries its name, the carousel the page sends
 * beside the text, the pictures the text places, and a plain-text lead for everything that reads `body`: a listing card, a
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
import { ALL_CHUNKS, loadRecords } from "../content/recent";
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

/** More than any article has carried, and few enough that a hostile list costs nothing to read. */
export const MAX_CAROUSEL = 50;

/** The longest description or caption, the same ceiling a figure in the text has. */
const MAX_MEDIA_TEXT = 500;

/** What the sanitiser writes for a clip. A picture is never one of these, and a clip never anything else. */
const isClip = (src: string) => /\.(mp4|mov|webm)$/i.test(src);

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

/**
 * The carousel the page sends: the pictures and clips shown above the text, in
 * order. Null when the page sent none at all, which is a page from before the
 * carousel could be edited; publishArticle then keeps the clips the article
 * had, as it always did.
 *
 * Every address must pass `allowed`: an upload made with this key, or a file
 * the article already shows. Nothing else can be put on the site from here.
 */
export function parseCarousel(
  raw: unknown,
  allowed: (url: string) => boolean,
): { ok: true; items: PublicMedia[] | null } | { ok: false; problem: string } {
  if (raw === undefined || raw === null) return { ok: true, items: null };
  if (!Array.isArray(raw)) return { ok: false, problem: "the carousel is not a list" };
  if (raw.length > MAX_CAROUSEL) return { ok: false, problem: `the carousel holds at most ${MAX_CAROUSEL} items` };

  const url = (value: unknown) =>
    typeof value === "string" && value !== "" && !/[\s"'<>\\]/.test(value) && allowed(value) ? value : null;
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, MAX_MEDIA_TEXT) : null;

  const items: PublicMedia[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return { ok: false, problem: "a carousel item is not one" };
    const item = entry as Record<string, unknown>;
    const type = item.type;
    if (type !== "image" && type !== "video") return { ok: false, problem: "a carousel item is neither a picture nor a clip" };

    const src = url(item.src);
    if (src === null) return { ok: false, problem: "a carousel item is not one uploaded for this article" };
    if (isClip(src) !== (type === "video")) return { ok: false, problem: "a carousel item is not the kind it says" };
    if (seen.has(src)) continue;
    seen.add(src);

    const thumbnail = item.thumbnail === undefined ? undefined : url(item.thumbnail);
    const poster = item.poster === undefined ? undefined : url(item.poster);
    if (thumbnail === null || poster === null) return { ok: false, problem: "a carousel item is not one uploaded for this article" };

    const fallback = type === "image" ? thumbnailOf(src) : undefined;
    items.push({
      type,
      src,
      ...(thumbnail ?? fallback ? { thumbnail: thumbnail ?? fallback } : {}),
      ...(poster ? { poster } : {}),
      alt: text(item.alt),
      caption: text(item.caption),
    });
  }
  return { ok: true, items };
}

/** One published file, as the folder and media id it is stored under. */
const fileOf = (url: string | undefined): string | null => {
  const location = url ? locateMedia(url) : null;
  return location ? `${location.activityId}/${location.mediaId}` : null;
};

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

  // Every record, not only this one: an update must not delete a file that
  // another article still shows, and only the whole feed can say which those are.
  let existing: PublicRecord | null = null;
  let others: PublicRecord[] = [];
  if (key.recordId !== null) {
    let all: PublicRecord[];
    try {
      all = await loadRecords(env, Number.POSITIVE_INFINITY, ALL_CHUNKS);
    } catch {
      return { status: "failed" };
    }
    existing = all.find((record) => record.id === key.recordId) ?? null;
    if (existing === null) return { status: "gone" };
    others = all.filter((record) => record.id !== key.recordId);
  }

  // Uploads made with this key, and the files the article already shows.
  const media = env.MEDIA_BASE_URL.replace(/\/$/, "");
  const folder = `${media}/media/activity-${key.activityId}/`;
  const kept = new Map((existing?.media ?? []).filter((item) => item.type === "image").map((item) => [item.src, item]));
  const existingUrls = new Set(
    (existing?.media ?? []).flatMap((item) => [item.src, item.thumbnail, item.poster].filter(Boolean) as string[]),
  );
  const allowed = (url: string) => url.startsWith(folder) || existingUrls.has(url);

  const cleaned = cleanDoc(parsed.doc, { allowSrc: (src) => !isClip(src) && (src.startsWith(folder) || kept.has(src)) });
  if (!cleaned.ok) return { status: "invalid", problem: cleaned.problem };
  const doc = cleaned.doc;

  const carousel = parseCarousel((raw as Record<string, unknown>).carousel, allowed);
  if (!carousel.ok) return { status: "invalid", problem: carousel.problem };

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

  // The carousel first, so its first item is the cover a listing card leads
  // with, then whatever the text places that the carousel does not already
  // hold. A page that sent no carousel is one from before it could be edited:
  // that article keeps the clips it had, after its pictures, as it always did.
  const inCarousel = new Set((carousel.items ?? []).map((item) => item.src));
  const recordMedia =
    carousel.items === null
      ? [...pictures, ...(existing?.media ?? []).filter((item) => item.type === "video")]
      : [...carousel.items, ...pictures.filter((item) => !inCarousel.has(item.src))];

  const fields = {
    ...parsed.input,
    body: docLead(doc) || null,
    media: recordMedia,
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

    // Files the article no longer shows, each by its own media id, so one
    // still shown is never caught by a folder-wide delete. Not one another
    // article shows either: a record can carry files from any folder, and the
    // folder a file sits in says nothing about who else uses it.
    const inUse = new Set(
      [...recordMedia, ...others.flatMap((record) => record.media ?? [])]
        .flatMap((item) => [fileOf(item.src), fileOf(item.thumbnail), fileOf(item.poster)])
        .filter((file): file is string => file !== null),
    );
    for (const item of existing.media ?? []) {
      const file = fileOf(item.src);
      if (file === null || inUse.has(file)) continue;
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
