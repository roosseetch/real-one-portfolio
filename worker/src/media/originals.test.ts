import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bodyFor, truncatedBody, type SampleFormat } from "../test-support/bytes";
import { createFakeBucket, type FakeBucket } from "../test-support/r2";
import { MAX_DOWNLOAD_BYTES, storeOriginal, type OriginalRequest } from "./originals";

let storage: FakeBucket;
/** Every outbound call, as {method, body}. */
let calls: Array<{ method: string; body: Record<string, unknown> }>;

/**
 * Telegram's two-step download: getFile names a path, then the path is fetched.
 * The body is a real header, because storeOriginal now checks it.
 */
function telegramServing(
  format: SampleFormat | "truncated",
  info: { file_path?: string; file_size?: number } = {},
) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const method = String(url).split("/").pop() ?? "";

    if (String(url).includes("/getFile")) {
      calls.push({ method: "getFile", body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({ ok: true, result: { file_path: "photos/file_1.jpg", ...info } }),
        { status: 200 },
      );
    }

    calls.push({ method: "download", body: {} });
    return new Response(format === "truncated" ? truncatedBody() : bodyFor(format), { status: 200 });
  });
}

beforeEach(() => {
  storage = createFakeBucket();
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

const env = () => ({ PRIVATE_BUCKET: storage.bucket, TELEGRAM_BOT_TOKEN: "test-token" });

const request = (overrides: Partial<OriginalRequest> = {}): OriginalRequest => ({
  type: "image",
  fileId: "file-1",
  ...overrides,
});

describe("storing an original", () => {
  it("stores the file and reports the key it was written under", async () => {
    telegramServing("jpeg");

    const result = await storeOriginal(env(), "activity1", request());

    expect(result.status).toBe("stored");
    if (result.status !== "stored") return;
    expect(result.original.key).toBe(`originals/activity1/${result.original.mediaId}.jpg`);
    expect(storage.objects.has(result.original.key)).toBe(true);
  });

  it("never puts the bot token in the stored original", async () => {
    telegramServing("jpeg");

    const result = await storeOriginal(env(), "activity1", request());

    expect(JSON.stringify(result)).not.toContain("test-token");
  });

  it("names the object from the bytes when Telegram's file path carries no extension", async () => {
    telegramServing("webp", { file_path: "documents/file_9" });

    const result = await storeOriginal(env(), "activity1", request());

    if (result.status !== "stored") throw new Error("expected the file to be stored");
    expect(result.original.key).toMatch(/\.webp$/);
  });
});

describe("files that never reach the bucket", () => {
  it("refuses a file the Bot API will not serve, without ever calling getFile", async () => {
    telegramServing("jpeg");

    const result = await storeOriginal(env(), "activity1", request({ bytes: MAX_DOWNLOAD_BYTES + 1 }));

    expect(result).toEqual({ status: "unavailable" });
    expect(calls).toEqual([]);
  });

  // A document arrives with no file_size of its own, so the check before
  // getFile can be skipped entirely and this is the only one left.
  it("refuses a file getFile itself reports as too large, before any of it is held in memory", async () => {
    telegramServing("jpeg", { file_size: MAX_DOWNLOAD_BYTES + 1 });

    const result = await storeOriginal(env(), "activity1", request());

    expect(result).toEqual({ status: "unavailable" });
    expect(calls.map((c) => c.method)).toEqual(["getFile"]);
  });

  it("writes nothing to R2 when the first bytes are not a format the sanitiser can open", async () => {
    telegramServing("heic");

    const result = await storeOriginal(env(), "activity1", request());

    expect(result).toMatchObject({ status: "wrong-format", label: "HEIC" });
    // The whole reason for buffering: a rejected file leaves no partial object.
    expect(storage.objects.size).toBe(0);
  });

  it("refuses a file whose bytes are nothing it recognises at all", async () => {
    telegramServing("gzip");

    const result = await storeOriginal(env(), "activity1", request());

    expect(result).toMatchObject({ status: "wrong-format", label: "compressed file" });
    expect(storage.objects.size).toBe(0);
  });

  it("refuses a file too short to carry a signature", async () => {
    telegramServing("truncated");

    const result = await storeOriginal(env(), "activity1", request());

    expect(result).toMatchObject({ status: "wrong-format", label: null });
  });

  it("distinguishes a file that could not be fetched from one whose contents were wrong", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("/getFile")) {
        return new Response(JSON.stringify({ ok: false, description: "file is temporarily unavailable" }), {
          status: 400,
        });
      }
      return new Response(bodyFor("jpeg"), { status: 200 });
    });

    expect(await storeOriginal(env(), "activity1", request())).toEqual({ status: "unavailable" });
  });
});

describe("what the bytes say against what was claimed", () => {
  // The workflow selects on `type == "image"`, so a video filed as an image is
  // handed to Pillow and the run fails with nothing said to anyone.
  it("files an mp4 as a video even when the document claimed to be an image", async () => {
    telegramServing("mp4", { file_path: "documents/file_3.mp4" });

    const result = await storeOriginal(env(), "activity1", request({ type: "image" }));

    if (result.status !== "stored") throw new Error("expected the file to be stored");
    expect(result.original.type).toBe("video");
  });

  it("files a jpeg as an image even when the document claimed to be a video", async () => {
    telegramServing("jpeg");

    const result = await storeOriginal(env(), "activity1", request({ type: "video" }));

    if (result.status !== "stored") throw new Error("expected the file to be stored");
    expect(result.original.type).toBe("image");
  });
});
