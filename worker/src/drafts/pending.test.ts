import { beforeEach, describe, expect, it } from "vitest";

import { createFakeBucket, type FakeBucket } from "../test-support/r2";
import { clearPendingEdit, setPendingEdit, takePendingEdit } from "./pending";

const CHAT = 99;
const DRAFT = "abc123def456ghjk";

let storage: FakeBucket;

beforeEach(() => {
  storage = createFakeBucket();
});

describe("pending edit pointer", () => {
  it("round-trips a draft id", async () => {
    await setPendingEdit(storage.bucket, CHAT, DRAFT);
    expect(await takePendingEdit(storage.bucket, CHAT)).toBe(DRAFT);
  });

  it("stores under drafts/, so the lifecycle rule sweeps it up", async () => {
    await setPendingEdit(storage.bucket, CHAT, DRAFT);
    expect([...storage.objects.keys()]).toEqual(["drafts/pending/99.json"]);
  });

  it("is consumed by the first message that claims it", async () => {
    // Otherwise every later message would keep being read as an instruction.
    await setPendingEdit(storage.bucket, CHAT, DRAFT);

    expect(await takePendingEdit(storage.bucket, CHAT)).toBe(DRAFT);
    expect(await takePendingEdit(storage.bucket, CHAT)).toBeNull();
  });

  it("returns null when the chat owes nothing", async () => {
    expect(await takePendingEdit(storage.bucket, CHAT)).toBeNull();
  });

  it("stops applying after half an hour", async () => {
    // A forgotten prompt must not silently swallow tomorrow's note as an edit.
    const start = new Date("2026-08-05T10:00:00.000Z");
    await setPendingEdit(storage.bucket, CHAT, DRAFT, start);

    const late = new Date(start.getTime() + 31 * 60 * 1000);
    expect(await takePendingEdit(storage.bucket, CHAT, late)).toBeNull();
  });

  it("still applies just inside the window", async () => {
    const start = new Date("2026-08-05T10:00:00.000Z");
    await setPendingEdit(storage.bucket, CHAT, DRAFT, start);

    const soon = new Date(start.getTime() + 29 * 60 * 1000);
    expect(await takePendingEdit(storage.bucket, CHAT, soon)).toBe(DRAFT);
  });

  it("clears an expired pointer rather than leaving it to be re-checked", async () => {
    const start = new Date("2026-08-05T10:00:00.000Z");
    await setPendingEdit(storage.bucket, CHAT, DRAFT, start);
    await takePendingEdit(storage.bucket, CHAT, new Date(start.getTime() + 31 * 60 * 1000));

    expect(storage.objects.size).toBe(0);
  });

  it("returns null for an unreadable pointer", async () => {
    storage.objects.set("drafts/pending/99.json", "{not json");
    expect(await takePendingEdit(storage.bucket, CHAT)).toBeNull();
  });

  it("refuses a chat id that could name a different object", async () => {
    for (const chatId of [NaN, Infinity, 1.5]) {
      await setPendingEdit(storage.bucket, chatId, DRAFT);
      expect(await takePendingEdit(storage.bucket, chatId)).toBeNull();
    }
    expect(storage.objects.size).toBe(0);
  });

  it("can be cleared without being read", async () => {
    await setPendingEdit(storage.bucket, CHAT, DRAFT);
    await clearPendingEdit(storage.bucket, CHAT);
    expect(storage.objects.size).toBe(0);
  });
});
