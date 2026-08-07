import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadDraft } from "../drafts/store";
import { createFakeBucket, type FakeBucket } from "../test-support/r2";
import type { TelegramMessage } from "../telegram/types";
import { intakeMedia, largestPhoto, mediaRequest } from "./intake";

const SENDER = 4242;

let storage: FakeBucket;
/** Every Telegram call, as {method, body}. */
let calls: Array<{ method: string; body: Record<string, unknown> }>;

beforeEach(() => {
  storage = createFakeBucket();
  calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const method = String(url).split("/").pop() ?? "";
    calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : {} });

    if (method === "getFile") {
      return new Response(JSON.stringify({ ok: true, result: { file_path: "photos/file_1.jpg", file_size: 2048 } }));
    }
    // The download itself: any body will do, the bytes are never inspected.
    return new Response("binary-image-bytes", { status: 200 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const env = () => ({ PRIVATE_BUCKET: storage.bucket, TELEGRAM_BOT_TOKEN: "test-token" });

function photoMessage(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 7,
    date: 1_700_000_000,
    chat: { id: 99, type: "private" },
    from: { id: SENDER },
    photo: [
      { file_id: "small", file_unique_id: "u1", width: 90, height: 60, file_size: 900 },
      { file_id: "large", file_unique_id: "u2", width: 1280, height: 853, file_size: 200_000 },
    ],
    ...overrides,
  };
}

describe("choosing which rendition to keep", () => {
  it("takes the largest, not the first", () => {
    // The smaller ones are Telegram's downscales; keeping one would cap the
    // resolution every published derivative is generated from.
    expect(largestPhoto(photoMessage())?.fileId).toBe("large");
  });

  it("falls back to a video when there is no photo", () => {
    const message = photoMessage({ photo: undefined });
    message.video = { file_id: "vid", file_unique_id: "u3", width: 1920, height: 1080, duration: 12 };
    expect(mediaRequest(message)).toMatchObject({ type: "video", fileId: "vid" });
  });

  it("returns null for a message carrying neither", () => {
    expect(mediaRequest(photoMessage({ photo: undefined }))).toBeNull();
  });
});

// Choosing "send as file" is how an author avoids Telegram re-compressing a
// picture, and Telegram does it unprompted with .webp. These arrive as
// documents, which used to match nothing and be dropped in silence.
describe("media sent as a file", () => {
  const asDocument = (mime: string | undefined, size = 616_000): TelegramMessage =>
    photoMessage({
      photo: undefined,
      document: {
        file_id: "doc",
        file_unique_id: "u9",
        file_name: "Image_20260806_114203.webp",
        ...(mime === undefined ? {} : { mime_type: mime }),
        file_size: size,
      },
    });

  it("takes a webp sent as a file", () => {
    expect(mediaRequest(asDocument("image/webp"))).toMatchObject({
      type: "image",
      fileId: "doc",
      bytes: 616_000,
    });
  });

  it("takes any other image type the sanitiser can open", () => {
    expect(mediaRequest(asDocument("image/png"))).toMatchObject({ type: "image", fileId: "doc" });
  });

  it("files a video document as a video, not an image", () => {
    expect(mediaRequest(asDocument("video/mp4"))).toMatchObject({ type: "video", fileId: "doc" });
  });

  it("refuses a file that is neither, rather than handing the sanitiser a PDF", () => {
    expect(mediaRequest(asDocument("application/pdf"))).toBeNull();
  });

  it("refuses a file Telegram gave no mime type for", () => {
    expect(mediaRequest(asDocument(undefined))).toBeNull();
  });

  it("prefers the photo when a message somehow carries both", () => {
    const message = asDocument("image/webp");
    message.photo = photoMessage().photo;
    expect(mediaRequest(message)?.fileId).toBe("large");
  });
});

describe("intakeMedia", () => {
  it("stores the original in the private bucket only", async () => {
    const result = await intakeMedia(photoMessage(), SENDER, env());

    expect(result.status).toBe("started");
    if (result.status !== "started") return;

    const keys = [...storage.objects.keys()];
    // Spec §10.1: no public object exists before approval.
    expect(keys).toContainEqual(expect.stringMatching(/^originals\/[0-9a-z]{16}\/[0-9a-z]{16}\.jpg$/));
    expect(keys.every((k) => k.startsWith("originals/") || k.startsWith("drafts/"))).toBe(true);
  });

  it("names the object with ids the Worker minted, never Telegram's", async () => {
    // Spec §8 keeps every object name under deterministic control.
    const result = await intakeMedia(photoMessage(), SENDER, env());
    if (result.status !== "started") throw new Error("expected a draft");

    const original = result.draft.originals[0];
    expect(original.key).toContain(result.draft.activityId);
    expect(original.key).toContain(original.mediaId);
    expect(original.key).not.toContain("large");
    expect(original.mediaId).not.toBe(result.draft.draftId);
  });

  it("keeps the Telegram file reference, so a preview costs no R2 read", async () => {
    const result = await intakeMedia(photoMessage(), SENDER, env());
    if (result.status !== "started") throw new Error("expected a draft");
    expect(result.draft.originals[0].fileId).toBe("large");
  });

  it("takes the caption as the draft's text", async () => {
    const result = await intakeMedia(photoMessage({ caption: "  coffee at the campus  " }), SENDER, env());
    if (result.status !== "started") throw new Error("expected a draft");
    expect(result.draft.input.text).toBe("coffee at the campus");
  });

  it("never puts the bot token in the stored draft", async () => {
    const result = await intakeMedia(photoMessage(), SENDER, env());
    if (result.status !== "started") throw new Error("expected a draft");
    expect(JSON.stringify(result.draft)).not.toContain("test-token");
  });
});

describe("albums", () => {
  const group = (n: number, extra: Partial<TelegramMessage> = {}) =>
    photoMessage({ message_id: n, media_group_id: "media-group-1", ...extra });

  it("files every item against one draft", async () => {
    // Telegram delivers an album as separate updates seconds apart; without the
    // pointer each would start its own draft and its own preview.
    const first = await intakeMedia(group(1, { caption: "three of them" }), SENDER, env());
    const second = await intakeMedia(group(2), SENDER, env());
    const third = await intakeMedia(group(3), SENDER, env());

    expect(first.status).toBe("started");
    expect(second.status).toBe("appended");
    expect(third.status).toBe("appended");

    if (first.status !== "started") return;
    const stored = await loadDraft(storage.bucket, first.draft.draftId);
    expect(stored?.originals).toHaveLength(3);
    expect([...storage.objects.keys()].filter((k) => k.endsWith("draft.json"))).toHaveLength(1);
  });

  it("keeps all three originals under one activity", async () => {
    const first = await intakeMedia(group(1), SENDER, env());
    await intakeMedia(group(2), SENDER, env());
    if (first.status !== "started") throw new Error("expected a draft");

    const stored = await loadDraft(storage.bucket, first.draft.draftId);
    const prefixes = new Set(stored?.originals.map((o) => o.key.split("/")[1]));
    expect(prefixes.size).toBe(1);
  });

  it("gives each item its own media id", async () => {
    const first = await intakeMedia(group(1), SENDER, env());
    await intakeMedia(group(2), SENDER, env());
    if (first.status !== "started") throw new Error("expected a draft");

    const stored = await loadDraft(storage.bucket, first.draft.draftId);
    const ids = stored?.originals.map((o) => o.mediaId) ?? [];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("starts a fresh draft for a different album", async () => {
    await intakeMedia(group(1), SENDER, env());
    const other = await intakeMedia(photoMessage({ message_id: 9, media_group_id: "media-group-2" }), SENDER, env());
    expect(other.status).toBe("started");
  });
});

describe("when a file cannot be fetched", () => {
  it("keeps the draft rather than losing the whole message", async () => {
    // One unreadable photo in an album should cost that photo, not the draft.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: false, description: "file is too big" }), { status: 400 }),
    );

    const result = await intakeMedia(photoMessage({ caption: "still worth keeping" }), SENDER, env());

    expect(result.status).toBe("started");
    if (result.status !== "started") return;
    expect(result.draft.originals).toHaveLength(0);
    expect(result.draft.input.text).toBe("still worth keeping");
  });
});
