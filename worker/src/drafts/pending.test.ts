import { beforeEach, describe, expect, it } from "vitest";

import { createFakeBucket, type FakeBucket } from "../test-support/r2";
import { clearPending, setPendingEdit, setPendingVerbatim, takePending } from "./pending";

const CHAT = 99;
const DRAFT = "abc123def456ghjk";

let storage: FakeBucket;

beforeEach(() => {
  storage = createFakeBucket();
});

describe("pending pointer", () => {
  it("round-trips a draft id", async () => {
    await setPendingEdit(storage.bucket, CHAT, DRAFT);
    expect(await takePending(storage.bucket, CHAT)).toEqual({ kind: "edit", draftId: DRAFT });
  });

  it("round-trips a verbatim note", async () => {
    await setPendingVerbatim(storage.bucket, CHAT);
    expect(await takePending(storage.bucket, CHAT)).toEqual({ kind: "verbatim" });
  });

  it("lets the newer request replace the older one", async () => {
    // The two share a key precisely so that asking for one after the other
    // cannot leave both armed, with the order of the checks deciding.
    await setPendingEdit(storage.bucket, CHAT, DRAFT);
    await setPendingVerbatim(storage.bucket, CHAT);

    expect(await takePending(storage.bucket, CHAT)).toEqual({ kind: "verbatim" });
  });

  it("reads a pointer written before it had a kind as an edit", async () => {
    // These live half an hour at most, so this only matters across a deploy —
    // where the alternative is swallowing the author's next message.
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    storage.objects.set("drafts/pending/99.json", JSON.stringify({ draftId: DRAFT, expiresAt }));

    expect(await takePending(storage.bucket, CHAT)).toEqual({ kind: "edit", draftId: DRAFT });
  });

  it("stores under drafts/, so the lifecycle rule sweeps it up", async () => {
    await setPendingEdit(storage.bucket, CHAT, DRAFT);
    expect([...storage.objects.keys()]).toEqual(["drafts/pending/99.json"]);
  });

  it("is consumed by the first message that claims it", async () => {
    // Otherwise every later message would keep being read as an instruction.
    await setPendingEdit(storage.bucket, CHAT, DRAFT);

    expect(await takePending(storage.bucket, CHAT)).toEqual({ kind: "edit", draftId: DRAFT });
    expect(await takePending(storage.bucket, CHAT)).toBeNull();
  });

  it("returns null when the chat owes nothing", async () => {
    expect(await takePending(storage.bucket, CHAT)).toBeNull();
  });

  it("stops applying after half an hour", async () => {
    // A forgotten prompt must not silently swallow tomorrow's note as an edit.
    const start = new Date("2026-08-05T10:00:00.000Z");
    await setPendingEdit(storage.bucket, CHAT, DRAFT, start);

    const late = new Date(start.getTime() + 31 * 60 * 1000);
    expect(await takePending(storage.bucket, CHAT, late)).toBeNull();
  });

  it("expires a verbatim pointer on the same deadline", async () => {
    const start = new Date("2026-08-05T10:00:00.000Z");
    await setPendingVerbatim(storage.bucket, CHAT, start);

    const late = new Date(start.getTime() + 31 * 60 * 1000);
    expect(await takePending(storage.bucket, CHAT, late)).toBeNull();
  });

  it("still applies just inside the window", async () => {
    const start = new Date("2026-08-05T10:00:00.000Z");
    await setPendingEdit(storage.bucket, CHAT, DRAFT, start);

    const soon = new Date(start.getTime() + 29 * 60 * 1000);
    expect(await takePending(storage.bucket, CHAT, soon)).toEqual({ kind: "edit", draftId: DRAFT });
  });

  it("clears an expired pointer rather than leaving it to be re-checked", async () => {
    const start = new Date("2026-08-05T10:00:00.000Z");
    await setPendingEdit(storage.bucket, CHAT, DRAFT, start);
    await takePending(storage.bucket, CHAT, new Date(start.getTime() + 31 * 60 * 1000));

    expect(storage.objects.size).toBe(0);
  });

  it("returns null for an unreadable pointer", async () => {
    storage.objects.set("drafts/pending/99.json", "{not json");
    expect(await takePending(storage.bucket, CHAT)).toBeNull();
  });

  it("refuses a chat id that could name a different object", async () => {
    for (const chatId of [NaN, Infinity, 1.5]) {
      await setPendingEdit(storage.bucket, chatId, DRAFT);
      expect(await takePending(storage.bucket, chatId)).toBeNull();
    }
    expect(storage.objects.size).toBe(0);
  });

  it("can be cleared without being read", async () => {
    await setPendingEdit(storage.bucket, CHAT, DRAFT);
    await clearPending(storage.bucket, CHAT);
    expect(storage.objects.size).toBe(0);
  });
});
