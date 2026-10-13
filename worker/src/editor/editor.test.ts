import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chunkKey } from "../content/chunks";
import { MANIFEST_KEY, type Manifest } from "../content/manifest";
import type { PublicRecord } from "../content/records";
import { loadDraft, saveDraft } from "../drafts/store";
import { takePending } from "../drafts/pending";
import { transition } from "../drafts/state";
import { bodyFor } from "../test-support/bytes";
import { createFakeBucket, type FakeBucket } from "../test-support/r2";
import type { TelegramCallbackQuery } from "../telegram/types";
import { KEY_TTL_MS, lookupKey, mintKey } from "./keys";
import { handleEditorRequest } from "./routes";
import { applyWriteTarget, editorUrl, handleWriteCallback, isWriteCallback, promptForWrite } from "./telegram";

const SITE = "https://site.example";
const MEDIA = "https://media.example";
const CHAT = 99;
const RECORD = "aaaaaaaaaaaaaaaa";

let storage: FakeBucket;
let content: FakeBucket;
let media: FakeBucket;
let calls: Array<{ url: string; method: string; body: Record<string, unknown> }>;

function env() {
  return {
    PRIVATE_BUCKET: storage.bucket,
    CONTENT_BUCKET: content.bucket,
    MEDIA_BUCKET: media.bucket,
    TELEGRAM_BOT_TOKEN: "test-token",
    SITE_BASE_URL: `${SITE}/`,
    MEDIA_BASE_URL: MEDIA,
    GITHUB_REPOSITORY: "owner/repo",
    MEDIA_WORKFLOW_FILE: "process-media.yml",
    GITHUB_DISPATCH_TOKEN: "gh-token",
  };
}

function record(overrides: Partial<PublicRecord> = {}): PublicRecord {
  return {
    id: RECORD,
    title: "A morning run",
    summary: null,
    body: "Eight kilometres before work.",
    eventDate: null,
    publishedAt: "2026-08-10T09:00:00.000Z",
    tags: [],
    media: [],
    ...overrides,
  };
}

function publish(chunks: PublicRecord[][]): void {
  const manifest: Manifest = {
    schemaVersion: 1,
    updatedAt: "2026-08-12T10:00:00.000Z",
    recordsPerFile: 10,
    totalRecords: chunks.reduce((sum, chunk) => sum + chunk.length, 0),
    records: chunks.map((chunk, index) => ({ id: `chunk${index}`, sha256: "x", count: chunk.length })),
    latest: chunks.length === 0 ? null : `chunk${chunks.length - 1}`,
  };
  for (const [index, chunk] of chunks.entries()) {
    content.objects.set(chunkKey(`chunk${index}`), JSON.stringify(chunk));
  }
  content.objects.set(MANIFEST_KEY, JSON.stringify(manifest));
}

function liveRecords(): PublicRecord[] {
  const manifest = JSON.parse(content.objects.get(MANIFEST_KEY) as string) as Manifest;
  return manifest.records.flatMap(
    (entry) => JSON.parse(content.objects.get(chunkKey(entry.id)) as string) as PublicRecord[],
  );
}

function request(
  path: string,
  init: { method?: string; key?: string | null; origin?: string; body?: BodyInit; noLength?: boolean } = {},
) {
  const headers = new Headers({ Origin: init.origin ?? SITE });
  if (init.key) headers.set("Authorization", `Bearer ${init.key}`);
  // A browser sends this for every file it uploads; a Request built here does not.
  if (init.body instanceof ArrayBuffer && !init.noLength) headers.set("content-length", String(init.body.byteLength));
  return new Request(`https://worker.example/editor/${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body,
  });
}

async function call(path: string, init: Parameters<typeof request>[1] = {}) {
  const response = await handleEditorRequest(request(path, init), env());
  const text = await response.text();
  return { status: response.status, headers: response.headers, json: text ? JSON.parse(text) : null };
}

const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

function article(overrides: Record<string, unknown> = {}) {
  return {
    title: "SCOPE Europe 2026",
    summary: "What changed.",
    eventDate: "2026-10-12",
    tags: ["Clinical trials"],
    doc: {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Workshop 1" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Set in " },
            { type: "text", text: "Fraunces", marks: [{ type: "textStyle", attrs: { fontFamily: "Fraunces" } }] },
          ],
        },
      ],
    },
    ...overrides,
  };
}

const sent = () => calls.filter((c) => c.method === "sendMessage").map((c) => String(c.body.text));

beforeEach(() => {
  storage = createFakeBucket();
  content = createFakeBucket();
  media = createFakeBucket();
  calls = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const parsed = new URL(String(url));
    calls.push({
      url: String(url),
      method: parsed.pathname.split("/").pop() ?? "",
      body: init?.body && typeof init.body === "string" ? JSON.parse(init.body) : {},
    });
    // GitHub answers a dispatch with 204; Telegram with a message.
    if (parsed.hostname === "api.github.com") return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 4242 } }), { status: 200 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("editor keys", () => {
  it("stores only the hash, and opens for four hours", async () => {
    const now = new Date("2026-10-13T10:00:00.000Z");
    const { key, expiresAt } = await mintKey(env(), "create", CHAT, null, now);

    expect(key).toMatch(/^crt_[0-9a-z]{32}$/);
    expect(expiresAt).toBe("2026-10-13T14:00:00.000Z");
    expect([...storage.objects.keys()].some((name) => name.includes(key))).toBe(false);

    expect((await lookupKey(env(), key, now)).status).toBe("valid");
    expect((await lookupKey(env(), key, new Date(now.getTime() + KEY_TTL_MS - 1))).status).toBe("valid");
    expect((await lookupKey(env(), key, new Date(now.getTime() + KEY_TTL_MS))).status).toBe("expired");
  });

  it("names the one record an update key opens", async () => {
    const { key } = await mintKey(env(), "update", CHAT, RECORD);
    const lookup = await lookupKey(env(), key);
    expect(key.startsWith("upd_")).toBe(true);
    expect(lookup.status === "valid" && lookup.key.recordId).toBe(RECORD);
  });

  it("refuses a key presented under the other prefix", async () => {
    const { key } = await mintKey(env(), "create", CHAT, null);
    expect((await lookupKey(env(), `upd_${key.slice(4)}`)).status).toBe("unknown");
  });

  it("refuses anything not shaped like a key", async () => {
    expect((await lookupKey(env(), "crt_short")).status).toBe("unknown");
    expect((await lookupKey(env(), null)).status).toBe("unknown");
  });
});

describe("editor routes: the gate", () => {
  it("answers only the site's origin", async () => {
    const { key } = await mintKey(env(), "create", CHAT, null);
    expect((await call("session", { key, origin: "https://evil.example" })).status).toBe(403);
  });

  it("answers a preflight with the methods and headers the page uses", async () => {
    const { status, headers } = await call("session", { method: "OPTIONS" });
    expect(status).toBe(204);
    expect(headers.get("Access-Control-Allow-Headers")).toContain("authorization");
    expect(headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });

  it("refuses a request with no key, and says when a key has expired", async () => {
    expect((await call("session")).json).toEqual({ status: "unknown" });

    const minted = await mintKey(env(), "create", CHAT, null, new Date(Date.now() - KEY_TTL_MS - 1000));
    const expired = await call("session", { key: minted.key });
    expect(expired.status).toBe(401);
    expect(expired.json).toEqual({ status: "expired" });
  });

  it("describes a create key's session", async () => {
    const { key } = await mintKey(env(), "create", CHAT, null);
    const { json } = await call("session", { key });
    expect(json.kind).toBe("create");
    expect(json.record).toBeNull();
    expect(json.mediaFolder).toMatch(new RegExp(`^${MEDIA}/media/activity-[0-9a-z]{16}/$`));
  });

  it("hands an update key's session the record it opens", async () => {
    publish([[record()]]);
    const { key } = await mintKey(env(), "update", CHAT, RECORD);
    const { json } = await call("session", { key });
    expect(json.kind).toBe("update");
    expect(json.record.id).toBe(RECORD);
  });
});

describe("editor routes: publishing", () => {
  it("publishes a new article, its document beside it, and tells the author", async () => {
    publish([[record()]]);
    const { key } = await mintKey(env(), "create", CHAT, null);

    const { status, json } = await call("publish", { method: "POST", key, body: JSON.stringify(article()) });
    expect(status).toBe(200);
    expect(json.created).toBe(true);

    const live = liveRecords().find((entry) => entry.id === json.recordId)!;
    expect(live.bodyFormat).toBe("rich");
    expect(live.body).toBe("Workshop 1\n\nSet in Fraunces");
    expect(live.tags).toEqual(["Clinical trials"]);

    const stored = content.objects.get(`content/articles/${live.id}-${live.doc}.json`);
    expect(JSON.parse(stored as string).content).toHaveLength(2);
    expect(content.cacheControl(`content/articles/${live.id}-${live.doc}.json`)).toContain("immutable");
    expect(sent().at(-1)).toContain('Published "SCOPE Europe 2026"');
  });

  it("amends the same article when a create key publishes twice", async () => {
    publish([[record()]]);
    const { key } = await mintKey(env(), "create", CHAT, null);

    const first = await call("publish", { method: "POST", key, body: JSON.stringify(article()) });
    const second = await call("publish", {
      method: "POST",
      key,
      body: JSON.stringify(article({ title: "SCOPE Europe 2026, revised" })),
    });

    expect(second.json.created).toBe(false);
    expect(second.json.recordId).toBe(first.json.recordId);
    expect(liveRecords()).toHaveLength(2);
    expect(liveRecords().find((entry) => entry.id === first.json.recordId)?.title).toBe("SCOPE Europe 2026, revised");
  });

  it("changes only the article an update key names, and keeps when it was published", async () => {
    publish([[record(), record({ id: "bbbbbbbbbbbbbbbb", title: "Another" })]]);
    const { key } = await mintKey(env(), "update", CHAT, RECORD);

    const { json } = await call("publish", { method: "POST", key, body: JSON.stringify(article()) });
    expect(json.recordId).toBe(RECORD);

    const [changed, other] = liveRecords();
    expect(changed.title).toBe("SCOPE Europe 2026");
    expect(changed.publishedAt).toBe("2026-08-10T09:00:00.000Z");
    expect(other.title).toBe("Another");
  });

  it("refuses a picture from outside the article's own folders", async () => {
    publish([[record()]]);
    const { key } = await mintKey(env(), "create", CHAT, null);
    const doc = { type: "doc", content: [{ type: "figure", attrs: { src: `${MEDIA}/media/activity-zzzzzzzzzzzzzzzz/x-800.webp` } }] };

    const { status, json } = await call("publish", { method: "POST", key, body: JSON.stringify(article({ doc })) });
    expect(status).toBe(422);
    expect(json.problem).toContain("picture");
    expect(liveRecords()).toHaveLength(1);
  });

  it("builds the record's media from the pictures the text places", async () => {
    publish([[record()]]);
    const { key } = await mintKey(env(), "create", CHAT, null);
    const folder = (await call("session", { key })).json.mediaFolder as string;
    const doc = {
      type: "doc",
      content: [
        paragraph("Before."),
        { type: "figure", attrs: { src: `${folder}abcdefghjkmnpqrs-1200.webp`, alt: "The room", caption: "Day one" } },
      ],
    };

    const { json } = await call("publish", { method: "POST", key, body: JSON.stringify(article({ doc })) });
    const live = liveRecords().find((entry) => entry.id === json.recordId)!;
    expect(live.media).toEqual([
      {
        type: "image",
        src: `${folder}abcdefghjkmnpqrs-1200.webp`,
        thumbnail: `${folder}abcdefghjkmnpqrs-320.webp`,
        alt: "The room",
        caption: "Day one",
      },
    ]);
  });

  it("deletes the files of a picture an update takes out of the text", async () => {
    const kept = `${MEDIA}/media/activity-cccccccccccccccc/dddddddddddddddd-800.webp`;
    const dropped = `${MEDIA}/media/activity-cccccccccccccccc/eeeeeeeeeeeeeeee-800.webp`;
    publish([[record({ media: [kept, dropped].map((src) => ({ type: "image", src, alt: null, caption: null })) })]]);
    media.objects.set("media/activity-cccccccccccccccc/dddddddddddddddd-800.webp", "x");
    media.objects.set("media/activity-cccccccccccccccc/eeeeeeeeeeeeeeee-800.webp", "x");
    const { key } = await mintKey(env(), "update", CHAT, RECORD);
    const doc = { type: "doc", content: [{ type: "figure", attrs: { src: kept } }] };

    await call("publish", { method: "POST", key, body: JSON.stringify(article({ doc })) });

    expect(media.objects.has("media/activity-cccccccccccccccc/dddddddddddddddd-800.webp")).toBe(true);
    expect(media.objects.has("media/activity-cccccccccccccccc/eeeeeeeeeeeeeeee-800.webp")).toBe(false);
  });

  it("refuses an article with no title", async () => {
    publish([[record()]]);
    const { key } = await mintKey(env(), "create", CHAT, null);
    const { status } = await call("publish", { method: "POST", key, body: JSON.stringify(article({ title: " " })) });
    expect(status).toBe(422);
  });
});

describe("editor routes: pictures", () => {
  it("files a picture privately and starts the sanitiser", async () => {
    const { key } = await mintKey(env(), "create", CHAT, null);
    const { status, json } = await call("media", { method: "POST", key, body: bodyFor("png") });

    expect(status).toBe(202);
    const draft = await loadDraft(storage.bucket, json.uploadId);
    expect(draft?.state).toBe("processing");
    expect(draft?.editor?.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(calls.some((c) => c.url.includes("/actions/workflows/process-media.yml/dispatches"))).toBe(true);

    expect((await call(`media/${json.uploadId}`, { key })).json).toEqual({ status: "processing" });
  });

  it("reports a picture ready once the callback has recorded it, and only to its own key", async () => {
    const { key } = await mintKey(env(), "create", CHAT, null);
    const { json } = await call("media", { method: "POST", key, body: bodyFor("jpeg") });
    const draft = (await loadDraft(storage.bucket, json.uploadId))!;
    const src = `${MEDIA}/media/activity-${draft.activityId}/x-1200.webp`;
    await saveDraft(storage.bucket, {
      ...transition(draft, "published"),
      processed: { media: [{ sourceId: "x", type: "image", src, visibleChanges: [] }], at: "now" },
    });

    expect((await call(`media/${json.uploadId}`, { key })).json).toEqual({ status: "ready", src });

    const other = await mintKey(env(), "create", CHAT, null);
    expect((await call(`media/${json.uploadId}`, { key: other.key })).status).toBe(404);
  });

  it("refuses an upload that does not say how large it is", async () => {
    const { key } = await mintKey(env(), "create", CHAT, null);
    expect((await call("media", { method: "POST", key, body: bodyFor("png"), noLength: true })).status).toBe(411);
  });

  it("refuses something that is not a picture", async () => {
    const { key } = await mintKey(env(), "create", CHAT, null);
    expect((await call("media", { method: "POST", key, body: bodyFor("mp4") })).status).toBe(415);
    expect((await call("media", { method: "POST", key, body: bodyFor("pdf") })).status).toBe(415);
  });
});

describe("editor routes: discard", () => {
  /** The folder a key's pictures go into, as object names and as the address the page sees. */
  async function folderOf(key: string) {
    const url = (await call("session", { key })).json.mediaFolder as string;
    return { url, prefix: new URL(url).pathname.slice(1) };
  }

  it("ends a link nothing was published from, and removes its pictures and their originals", async () => {
    const { key } = await mintKey(env(), "create", CHAT, null);
    const upload = await call("media", { method: "POST", key, body: bodyFor("jpeg") });
    expect(upload.status).toBe(202);
    const { prefix } = await folderOf(key);
    media.objects.set(`${prefix}ffffffffffffffff-1200.webp`, "x");
    media.objects.set(`${prefix}ffffffffffffffff-320.avif`, "x");

    const { status, json } = await call("discard", { method: "POST", key });

    expect(status).toBe(200);
    expect(json).toMatchObject({ status: "discarded", removed: 2, articleKept: false });
    expect([...media.objects.keys()]).toEqual([]);
    expect([...storage.objects.keys()].some((name) => name.startsWith("originals/"))).toBe(false);
    expect((await call("session", { key })).json).toEqual({ status: "unknown" });
  });

  it("leaves a published article and the pictures it shows, and drops the rest", async () => {
    publish([[record()]]);
    const { key } = await mintKey(env(), "create", CHAT, null);
    const { url, prefix } = await folderOf(key);
    for (const name of ["aaaaaaaaaaaaaaab-1200.webp", "aaaaaaaaaaaaaaab-320.webp", "bbbbbbbbbbbbbbbc-1200.webp"]) {
      media.objects.set(`${prefix}${name}`, "x");
    }
    const doc = { type: "doc", content: [{ type: "figure", attrs: { src: `${url}aaaaaaaaaaaaaaab-1200.webp` } }] };
    const published = await call("publish", { method: "POST", key, body: JSON.stringify(article({ doc })) });

    const { json } = await call("discard", { method: "POST", key });

    expect(json).toMatchObject({ status: "discarded", removed: 1, articleKept: true });
    expect(liveRecords().some((entry) => entry.id === published.json.recordId)).toBe(true);
    expect([...media.objects.keys()].sort()).toEqual([
      `${prefix}aaaaaaaaaaaaaaab-1200.webp`,
      `${prefix}aaaaaaaaaaaaaaab-320.webp`,
    ]);
  });

  it("still clears up after a link that has expired", async () => {
    const { key } = await mintKey(env(), "create", CHAT, null, new Date(Date.now() - KEY_TTL_MS - 1000));
    expect((await call("discard", { method: "POST", key })).status).toBe(200);
    expect((await lookupKey(env(), key)).status).toBe("unknown");
  });

  it("refuses a key that was never handed out, or is already discarded", async () => {
    const { key } = await mintKey(env(), "create", CHAT, null);
    await call("discard", { method: "POST", key });
    expect((await call("discard", { method: "POST", key })).json).toEqual({ status: "unknown" });
  });

  it("keeps the key when the article cannot be read, so nothing it shows is lost", async () => {
    const { key } = await mintKey(env(), "update", CHAT, RECORD);
    publish([[record()]]);
    // Storage refusing the read, as opposed to the article not being there.
    vi.spyOn(content.bucket, "get").mockRejectedValue(new Error("R2 unavailable"));
    expect((await call("discard", { method: "POST", key })).status).toBe(503);
    expect((await lookupKey(env(), key)).status).toBe("valid");
  });
});

describe("asking the bot for a link", () => {
  const press = (data: string): TelegramCallbackQuery => ({
    id: "cb-1",
    from: { id: 42 },
    data,
    message: { message_id: 7, date: 0, chat: { id: CHAT, type: "private" } },
  });

  it("claims its own namespace", () => {
    expect(isWriteCallback("wr:n")).toBe(true);
    expect(isWriteCallback("ea:x")).toBe(false);
  });

  it("puts the key in the editor's address on the site", () => {
    expect(editorUrl("https://site.example/portfolio", "crt_x")).toBe("https://site.example/portfolio/admin/?key=crt_x");
  });

  it("asks new or update, then sends a create link with no preview", async () => {
    await promptForWrite(env(), CHAT);
    await handleWriteCallback(press("wr:n"), env());

    const message = calls.filter((c) => c.method === "sendMessage").at(-1)!;
    expect(String(message.body.text)).toMatch(/https:\/\/site\.example\/admin\/\?key=crt_[0-9a-z]{32}/);
    expect(message.body.link_preview_options).toEqual({ is_disabled: true });
  });

  it("offers the newest articles for an update, and sends a link for the one picked", async () => {
    publish([[record()]]);
    await handleWriteCallback(press("wr:u"), env());
    expect((await takePending(storage.bucket, CHAT))?.kind).toBe("write-target");

    await handleWriteCallback(press(`wr:p:${RECORD}`), env());
    const text = sent().at(-1)!;
    expect(text).toContain('change "A morning run"');
    expect(text).toContain("only for this article");

    const key = /key=(upd_[0-9a-z]{32})/.exec(text)![1];
    const lookup = await lookupKey(env(), key);
    expect(lookup.status === "valid" && lookup.key.recordId).toBe(RECORD);
  });

  it("takes a typed link to the article as the answer", async () => {
    publish([[record()]]);
    await applyWriteTarget(env(), CHAT, RECORD);
    expect(sent().at(-1)).toContain("key=upd_");
  });
});
