/**
 * The article editor's API, called by the site's /admin/ page.
 *
 *   GET  /editor/session         what the key may do, and the article it opens
 *   POST /editor/media           a picture for the text (raw bytes)
 *   GET  /editor/media/<id>      whether that picture is ready yet
 *   POST /editor/publish         the article, as JSON
 *   POST /editor/discard         end the link and remove what was never published
 *
 * Every route needs the key from the bot's link, as `Authorization: Bearer`.
 * Never in this URL: a query string lands in logs that a header does not. The
 * site's origin and nothing else may call it, through the same guard the
 * contact form's endpoints use.
 */
import { answer, guard, type ContactOriginEnv, type CorsPolicy } from "../contact/cors";
import { MAX_DOC_BYTES } from "../../../site/src/rich-doc";
import { ALL_CHUNKS, findRecord } from "../content/recent";
import { isValidId } from "../ids";
import { discardKey, type EditorDiscardEnv } from "./discard";
import { lookupKey, presentedKey } from "./keys";
import { pictureStatus, uploadPicture, type EditorMediaEnv } from "./media";
import { publishArticle, type EditorPublishEnv } from "./publish";

export interface EditorEnv extends ContactOriginEnv, EditorMediaEnv, EditorPublishEnv, EditorDiscardEnv {}

export const EDITOR_PREFIX = "/editor/";

const POLICY: CorsPolicy = { methods: ["GET", "POST"], headers: ["authorization", "content-type"] };

/** The fields and the document, with room to spare; the document's own ceiling is checked again when it is parsed. */
const MAX_ARTICLE_BYTES = MAX_DOC_BYTES + 64 * 1024;

export function isEditorPath(pathname: string): boolean {
  return pathname.startsWith(EDITOR_PREFIX);
}

export async function handleEditorRequest(request: Request, env: EditorEnv): Promise<Response> {
  const guarded = guard(request, env, POLICY);
  if (typeof guarded !== "string") return guarded;
  const origin = guarded;
  const reply = (status: number, body?: Record<string, unknown>) => answer(status, origin, body, POLICY);

  const path = new URL(request.url).pathname.slice(EDITOR_PREFIX.length);
  const lookup = await lookupKey(env, presentedKey(request));

  // The one thing an expired key may still do: clearing up after itself
  // destroys only what it made, and the page offers it on an expired link.
  if (request.method === "POST" && path === "discard" && lookup.status !== "unknown") {
    const outcome = await discardKey(env, lookup.key, lookup.hash);
    return outcome.status === "discarded" ? reply(200, outcome) : reply(503, { status: "unavailable" });
  }

  if (lookup.status !== "valid") {
    // Expired is said out loud, because the page's answer to it — ask the bot
    // for a new link — is different from its answer to a key that never was.
    return reply(401, { status: lookup.status });
  }
  const { key, hash } = lookup;

  if (request.method === "GET" && path === "session") {
    let record = null;
    if (key.recordId !== null) {
      try {
        record = await findRecord(env, key.recordId, ALL_CHUNKS);
      } catch {
        return reply(503, { status: "unavailable" });
      }
      if (record === null) return reply(404, { status: "gone" });
    }
    return reply(200, {
      status: "ok",
      kind: key.kind,
      expiresAt: key.expiresAt,
      mediaFolder: `${env.MEDIA_BASE_URL.replace(/\/$/, "")}/media/activity-${key.activityId}/`,
      record,
    });
  }

  if (request.method === "POST" && path === "media") {
    const result = await uploadPicture(env, key, hash, request);
    switch (result.status) {
      case "uploaded":
        return reply(202, { status: "processing", uploadId: result.uploadId });
      case "too-large":
        return reply(413, { status: "too-large" });
      case "length-required":
        return reply(411, { status: "length-required" });
      case "not-a-picture":
        return reply(415, { status: "not-a-picture", label: result.label });
      case "unavailable":
        return reply(503, { status: "unavailable" });
    }
  }

  if (request.method === "GET" && path.startsWith("media/")) {
    const uploadId = path.slice("media/".length);
    if (!isValidId(uploadId)) return reply(404, { status: "unknown" });
    const status = await pictureStatus(env, hash, uploadId);
    return reply(status.status === "unknown" ? 404 : 200, status);
  }

  if (request.method === "POST" && path === "publish") {
    if (Number(request.headers.get("content-length") ?? "0") > MAX_ARTICLE_BYTES) {
      return reply(413, { status: "too-large" });
    }
    let raw: unknown;
    try {
      const text = await request.text();
      if (text.length > MAX_ARTICLE_BYTES) return reply(413, { status: "too-large" });
      raw = JSON.parse(text);
    } catch {
      return reply(400, { status: "invalid", problem: "not JSON" });
    }

    const outcome = await publishArticle(env, key, hash, raw);
    switch (outcome.status) {
      case "published":
        return reply(200, outcome);
      case "invalid":
        return reply(422, outcome);
      case "gone":
        return reply(404, outcome);
      case "failed":
        return reply(503, outcome);
    }
  }

  return reply(404, { status: "unknown" });
}
