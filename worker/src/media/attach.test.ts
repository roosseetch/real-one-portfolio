import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chunkKey } from "../content/chunks";
import { MANIFEST_KEY, type Manifest } from "../content/manifest";
import type { PublicRecord } from "../content/records";
import { setPendingAttach, takePending } from "../drafts/pending";
import { loadDraft, saveDraft } from "../drafts/store";
import { intakeUpdate } from "../drafts/intake";
import type { Draft } from "../drafts/types";
import { DRAFT_SCHEMA_VERSION } from "../drafts/types";
import { createFakeBucket, type FakeBucket } from "../test-support/r2";
import type { TelegramCallbackQuery, TelegramUpdate } from "../telegram/types";
import { describeFiles, handleAttachCallback, isAttachCallback, parseAttachCallback } from "./attach";

let storage: FakeBucket;
let content: FakeBucket;
let media: FakeBucket;
/** Every outbound Telegram call, as {method, body}. */
let calls: Array<{ method: string; body: Record<string, unknown> }>;
/** Whether GitHub accepts the workflow dispatch. */
let dispatchStatus: number;

const CHAT = 99;
const SENDER = 42;

function env() {
  return {
    PRIVATE_BUCKET: storage.bucket,
    CONTENT_BUCKET: content.bucket,
    MEDIA_BUCKET: media.bucket,
    AI: {} as Ai,
    TELEGRAM_BOT_TOKEN: "test-token",
    SITE_BASE_URL: "https://site.example",
    MEDIA_BASE_URL: "https://media.example",
    GITHUB_REPOSITORY: "owner/repo",
    MEDIA_WORKFLOW_FILE: "process-media.yml",
    GITHUB_DISPATCH_TOKEN: "dispatch-token",
    WORKER_BASE_URL: "https://worker.example",
    LINKEDIN_CLIENT_ID: "",
    LINKEDIN_CLIENT_SECRET: "",
  } as never;
}

function record(id: string, title: string, publishedAt: string): PublicRecord {
  return {
    id,
    title,
    summary: null,
    body: null,
    eventDate: null,
    publishedAt,
    tags: [],
    media: [],
  };
}

function publish(records: PublicRecord[]): void {
  const manifest: Manifest = {
    schemaVersion: 1,
    updatedAt: "2026-08-12T10:00:00.000Z",
    recordsPerFile: 10,
    totalRecords: records.length,
    records: records.length === 0 ? [] : [{ id: "chunk0", sha256: "x", count: records.length }],
    latest: records.length === 0 ? null : "chunk0",
  };

  content.objects.set(chunkKey("chunk0"), JSON.stringify(records));
  content.objects.set(MANIFEST_KEY, JSON.stringify(manifest));
}

/** A photo message, as Telegram delivers one. */
function photo(messageId: number, groupId?: string): TelegramUpdate {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      date: 0,
      chat: { id: CHAT, type: "private" },
      from: { id: SENDER },
      ...(groupId ? { media_group_id: groupId } : {}),
      photo: [{ file_id: `file-${messageId}`, file_unique_id: `u${messageId}`, width: 1600, height: 1200 }],
    },
  } as TelegramUpdate;
}

function text(messageId: number, body: string): TelegramUpdate {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      date: 0,
      chat: { id: CHAT, type: "private" },
      from: { id: SENDER },
      text: body,
    },
  } as TelegramUpdate;
}

function press(data: string): TelegramCallbackQuery {
  return {
    id: "cb-1",
    from: { id: SENDER },
    data,
    message: { message_id: 7, date: 0, chat: { id: CHAT, type: "private" } },
  };
}

/** Messages the bot sent, in order. */
function sent(): string[] {
  return calls.filter((c) => c.method === "sendMessage").map((c) => String(c.body.text));
}

function lastKeyboard(): Array<Array<{ text: string; callback_data: string }>> {
  const withMarkup = calls.filter((c) => c.body.reply_markup !== undefined);
  const markup = withMarkup[withMarkup.length - 1]?.body.reply_markup as {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  };
  return markup?.inline_keyboard ?? [];
}

/** The one draft in the bucket. */
async function theDraft(): Promise<Draft> {
  const key = [...storage.objects.keys()].find((k) => k.endsWith("/draft.json")) as string;
  const id = key.slice("drafts/".length, -"/draft.json".length);
  return (await loadDraft(storage.bucket, id)) as Draft;
}

/** Drives the flow to the point where the chooser is on screen. */
async function sendOnePhoto(): Promise<Draft> {
  await setPendingAttach(storage.bucket, CHAT);
  await intakeUpdate(photo(1), SENDER, env());
  return theDraft();
}

beforeEach(() => {
  storage = createFakeBucket();
  content = createFakeBucket();
  media = createFakeBucket();
  calls = [];
  dispatchStatus = 204;

  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const target = new URL(String(url));

    if (target.host === "api.github.com") return new Response(null, { status: dispatchStatus });

    // Telegram's getFile, and then the download it points at.
    if (target.pathname.endsWith("/getFile")) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: "photos/one.jpg", file_size: 1024 } }), {
        status: 200,
      });
    }
    if (target.pathname.includes("/file/bot")) {
      // A JPEG's signature, so the sniffer accepts the bytes.
      const bytes = new Uint8Array(64);
      bytes.set([0xff, 0xd8, 0xff, 0xe0]);
      return new Response(bytes, { status: 200 });
    }

    const method = target.pathname.split("/").pop() ?? "";
    calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : {} });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 4242 } }), { status: 200 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isAttachCallback", () => {
  it("claims its own namespace and nothing else", () => {
    expect(isAttachCallback("am:p:draft:token:record")).toBe(true);
    // The draft preview's codes and the repost flow's, which must keep reaching
    // their own handlers.
    expect(isAttachCallback("p:draft123:token123")).toBe(false);
    expect(isAttachCallback("l:p:record")).toBe(false);
    expect(isAttachCallback("rm:p:record")).toBe(false);
    expect(isAttachCallback(undefined)).toBe(false);
  });
});

describe("parseAttachCallback", () => {
  it("reads the shapes it draws", () => {
    expect(parseAttachCallback("am:p:draft1:token1:record1")).toEqual({
      action: "pick",
      draftId: "draft1",
      token: "token1",
      recordId: "record1",
    });
    expect(parseAttachCallback("am:g:draft1:token1")).toEqual({
      action: "go",
      draftId: "draft1",
      token: "token1",
      recordId: null,
    });
  });

  it("rejects anything else wholesale", () => {
    for (const data of [
      "am:",
      "am:p:draft1:token1",
      "am:g:draft1:token1:record1",
      "am:z:draft1:token1",
      "am:p::token1:record1",
      "am:p:draft1::record1",
      "am:p:a:b:c:d",
    ]) {
      expect(parseAttachCallback(data)).toBeNull();
    }
  });
});

describe("describeFiles", () => {
  it("counts what arrived, in the words the confirmation uses", () => {
    const of = (types: Array<"image" | "video">) =>
      describeFiles({
        originals: types.map((type, index) => ({ mediaId: `m${index}`, type, fileId: "f", key: "k" })),
      } as Draft);

    expect(of(["image"])).toBe("1 photo");
    expect(of(["image", "image"])).toBe("2 photos");
    expect(of(["video"])).toBe("1 video");
    expect(of(["image", "image", "video"])).toBe("2 photos and 1 video");
  });
});

describe("the add-media flow", () => {
  /**
   * The pointer the "Add media" button leaves is the only thing that tells this
   * from someone sending a photo to make a new activity, which is what a photo
   * to this bot has always meant.
   */
  it("files the photo against an attachment draft rather than describing it", async () => {
    publish([record("aaaaaaaaaaaaaaaa", "A morning run", "2026-08-10T09:00:00.000Z")]);

    const draft = await sendOnePhoto();

    expect(draft.attachment).toEqual({ recordId: null });
    expect(draft.record).toBeNull();
    expect(draft.originals).toHaveLength(1);
    expect(draft.state).toBe("awaiting_approval");
  });

  it("offers the newest activities, plus a way to name one by hand", async () => {
    publish([
      record("aaaaaaaaaaaaaaaa", "A morning run", "2026-08-01T09:00:00.000Z"),
      record("bbbbbbbbbbbbbbbb", "A longer ride", "2026-08-10T09:00:00.000Z"),
    ]);

    const draft = await sendOnePhoto();

    expect(sent().at(-1)).toContain("1 photo received");
    const keyboard = lastKeyboard();
    expect(keyboard[0][0].text).toBe("Latest — A longer ride");
    expect(keyboard[0][0].callback_data).toBe(`am:p:${draft.draftId}:${draft.preview?.token}:bbbbbbbbbbbbbbbb`);
    expect(keyboard.at(-2)?.[0].text).toContain("Other");
    expect(keyboard.at(-1)?.[0].text).toBe("Cancel");
  });

  it("says so, and keeps nothing, when there is no activity to add to", async () => {
    publish([]);

    await setPendingAttach(storage.bucket, CHAT);
    await intakeUpdate(photo(1), SENDER, env());

    expect(sent().at(-1)).toContain("Nothing has been published yet");
    expect((await theDraft()).state).toBe("cancelled");
  });

  it("confirms against the activity chosen, and only then dispatches", async () => {
    publish([record("aaaaaaaaaaaaaaaa", "A morning run", "2026-08-10T09:00:00.000Z")]);
    const draft = await sendOnePhoto();

    await handleAttachCallback(
      press(`am:p:${draft.draftId}:${draft.preview?.token}:aaaaaaaaaaaaaaaa`),
      env(),
    );

    expect(sent().at(-1)).toContain('Add 1 photo to "A morning run"?');
    // Nothing has been dispatched: the author has not said yes yet.
    expect(calls.some((c) => c.method === "dispatches")).toBe(false);

    const targeted = await theDraft();
    expect(targeted.attachment).toEqual({ recordId: "aaaaaaaaaaaaaaaa" });
    expect(targeted.state).toBe("awaiting_approval");

    await handleAttachCallback(press(`am:g:${targeted.draftId}:${targeted.preview?.token}`), env());

    const processing = await theDraft();
    expect(processing.state).toBe("processing");
    expect(processing.job).not.toBeNull();
    expect(sent().at(-1)).toContain("Processing the media");
  });

  it("takes a pasted link instead of a button", async () => {
    publish([record("aaaaaaaaaaaaaaaa", "A morning run", "2026-08-10T09:00:00.000Z")]);
    const draft = await sendOnePhoto();

    await handleAttachCallback(press(`am:o:${draft.draftId}:${draft.preview?.token}`), env());
    expect(await takePending(storage.bucket, CHAT)).toEqual({
      kind: "attach-target",
      draftId: draft.draftId,
    });

    // Re-armed, because takePending above consumed it.
    await handleAttachCallback(press(`am:o:${draft.draftId}:${(await theDraft()).preview?.token}`), env());
    await intakeUpdate(text(2, "https://site.example/activities/?v=a-morning-run"), SENDER, env());

    expect(sent().at(-1)).toContain('Add 1 photo to "A morning run"?');
    expect((await theDraft()).attachment).toEqual({ recordId: "aaaaaaaaaaaaaaaa" });
  });

  it("asks again rather than making a new activity out of a link that matches nothing", async () => {
    publish([record("aaaaaaaaaaaaaaaa", "A morning run", "2026-08-10T09:00:00.000Z")]);
    const draft = await sendOnePhoto();

    await handleAttachCallback(press(`am:o:${draft.draftId}:${draft.preview?.token}`), env());
    await intakeUpdate(text(2, "a-run-that-never-happened"), SENDER, env());

    expect(sent().at(-1)).toContain("could not find an activity");
    // Still armed, so the next attempt is read as another try rather than a note.
    expect(await takePending(storage.bucket, CHAT)).toEqual({
      kind: "attach-target",
      draftId: draft.draftId,
    });
    expect((await theDraft()).attachment).toEqual({ recordId: null });
  });

  it("cancels without publishing or dispatching anything", async () => {
    publish([record("aaaaaaaaaaaaaaaa", "A morning run", "2026-08-10T09:00:00.000Z")]);
    const draft = await sendOnePhoto();

    await handleAttachCallback(press(`am:x:${draft.draftId}:${draft.preview?.token}`), env());

    expect((await theDraft()).state).toBe("cancelled");
    expect(sent().at(-1)).toBe("Cancelled. Nothing was added.");
    expect(calls.some((c) => c.method === "dispatches")).toBe(false);
  });

  it("refuses a press from a superseded message", async () => {
    publish([record("aaaaaaaaaaaaaaaa", "A morning run", "2026-08-10T09:00:00.000Z")]);
    const draft = await sendOnePhoto();

    await handleAttachCallback(press(`am:g:${draft.draftId}:wrongtoken00`), env());

    const answer = calls.find((c) => c.method === "answerCallbackQuery");
    expect(String(answer?.body.text)).toContain("replaced");
    expect((await theDraft()).state).toBe("awaiting_approval");
  });

  it("refuses to start work before an activity has been chosen", async () => {
    publish([record("aaaaaaaaaaaaaaaa", "A morning run", "2026-08-10T09:00:00.000Z")]);
    const draft = await sendOnePhoto();

    await handleAttachCallback(press(`am:g:${draft.draftId}:${draft.preview?.token}`), env());

    const answer = calls.filter((c) => c.method === "answerCallbackQuery").at(-1);
    expect(String(answer?.body.text)).toContain("Choose the activity first");
    expect((await theDraft()).state).toBe("awaiting_approval");
    expect(calls.some((c) => c.method === "dispatches")).toBe(false);
  });

  it("says what happened when the draft has already moved on", async () => {
    publish([record("aaaaaaaaaaaaaaaa", "A morning run", "2026-08-10T09:00:00.000Z")]);
    const draft = await sendOnePhoto();
    await saveDraft(storage.bucket, { ...draft, state: "cancelled" });

    await handleAttachCallback(press(`am:g:${draft.draftId}:${draft.preview?.token}`), env());

    const answer = calls.filter((c) => c.method === "answerCallbackQuery").at(-1);
    expect(String(answer?.body.text)).toBe("Already cancelled.");
  });

  /**
   * The pointer is consumed by the item that creates the draft. Taking it per
   * item would have the second photo of an album start a second draft, and that
   * one would not be an attachment at all.
   */
  it("keeps a whole album on one attachment draft", async () => {
    publish([record("aaaaaaaaaaaaaaaa", "A morning run", "2026-08-10T09:00:00.000Z")]);

    await setPendingAttach(storage.bucket, CHAT);
    await intakeUpdate(photo(1, "group-1"), SENDER, env());
    await intakeUpdate(photo(2, "group-1"), SENDER, env());

    const drafts = [...storage.objects.keys()].filter((k) => k.endsWith("/draft.json"));
    expect(drafts).toHaveLength(1);

    const draft = await theDraft();
    expect(draft.attachment).toEqual({ recordId: null });
    expect(draft.originals).toHaveLength(2);
  });

  /**
   * The pointer is spent by the time a file is refused, so without putting it
   * back the author's next photo would quietly become a new activity instead.
   */
  it("stays armed when the file sent was not one it could use", async () => {
    publish([record("aaaaaaaaaaaaaaaa", "A morning run", "2026-08-10T09:00:00.000Z")]);

    await setPendingAttach(storage.bucket, CHAT);
    await intakeUpdate(
      {
        update_id: 1,
        message: {
          message_id: 1,
          date: 0,
          chat: { id: CHAT, type: "private" },
          from: { id: SENDER },
          document: { file_id: "f", file_unique_id: "u", mime_type: "application/pdf", file_name: "notes.pdf" },
        },
      } as TelegramUpdate,
      SENDER,
      env(),
    );

    expect(sent().at(-1)).toContain("I can only publish images and videos");
    expect(await takePending(storage.bucket, CHAT)).toEqual({ kind: "attach" });
    expect([...storage.objects.keys()].some((k) => k.endsWith("/draft.json"))).toBe(false);
  });

  /**
   * A photo with no pointer is what it has always been: the start of a new
   * activity. Nothing about adding media may change that.
   */
  it("leaves an ordinary photo to become an activity of its own", async () => {
    publish([record("aaaaaaaaaaaaaaaa", "A morning run", "2026-08-10T09:00:00.000Z")]);

    await intakeUpdate(photo(1), SENDER, env());

    expect((await theDraft()).attachment).toBeNull();
  });

  it("does not swallow an outstanding edit instruction when a photo arrives", async () => {
    publish([record("aaaaaaaaaaaaaaaa", "A morning run", "2026-08-10T09:00:00.000Z")]);

    // An edit was promised, and then a photo turned up. The photo is a new
    // draft; the instruction is still owed.
    const other: Draft = {
      schemaVersion: DRAFT_SCHEMA_VERSION,
      draftId: "eee123def456ghjk",
      state: "awaiting_approval",
      createdAt: "2026-08-12T09:00:00.000Z",
      updatedAt: "2026-08-12T09:00:00.000Z",
      source: { chatId: CHAT, senderId: SENDER, messageId: 1 },
      activityId: "act123def456ghjk",
      mediaGroupId: null,
      originals: [],
      mediaDeclined: false,
      input: { text: "a run" },
      record: null,
      attachment: null,
      preview: null,
      published: null,
      job: null,
      processed: null,
    };
    await saveDraft(storage.bucket, other);
    const { setPendingEdit } = await import("../drafts/pending");
    await setPendingEdit(storage.bucket, CHAT, other.draftId);

    await intakeUpdate(photo(9), SENDER, env());

    expect(await takePending(storage.bucket, CHAT)).toEqual({ kind: "edit", draftId: other.draftId });
  });
});
