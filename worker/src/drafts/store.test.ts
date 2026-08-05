import { describe, expect, it } from "vitest";

import { createFakeBucket } from "../test-support/r2";
import { createDraft, draftKey, loadDraft, saveDraft } from "./store";
import type { Draft } from "./types";

const SOURCE = { chatId: 99, senderId: 42, messageId: 7 };

describe("createDraft", () => {
  it("writes the draft under drafts/{id}/draft.json", async () => {
    const { bucket, objects } = createFakeBucket();
    const draft = await createDraft(bucket, SOURCE, "a morning run");

    expect(objects.has(`drafts/${draft.draftId}/draft.json`)).toBe(true);
    expect(draftKey(draft.draftId)).toBe(`drafts/${draft.draftId}/draft.json`);
  });

  it("starts in state draft with no record yet", async () => {
    const { bucket } = createFakeBucket();
    const draft = await createDraft(bucket, SOURCE, "a morning run");

    expect(draft.state).toBe("draft");
    // Null rather than absent: this is what lets a Workers AI quota failure
    // leave a draft that is still worth resuming.
    expect(draft.record).toBeNull();
    expect(draft.schemaVersion).toBe(1);
  });

  it("keeps the raw input and the chat to reply to", async () => {
    const { bucket } = createFakeBucket();
    const draft = await createDraft(bucket, SOURCE, "a morning run");

    expect(draft.input.text).toBe("a morning run");
    expect(draft.source).toEqual(SOURCE);
  });

  it("stamps both timestamps at creation", async () => {
    const { bucket } = createFakeBucket();
    const draft = await createDraft(bucket, SOURCE, "a morning run", new Date("2026-08-05T10:00:00.000Z"));

    expect(draft.createdAt).toBe("2026-08-05T10:00:00.000Z");
    expect(draft.updatedAt).toBe("2026-08-05T10:00:00.000Z");
  });

  it("gives every draft a different id", async () => {
    const { bucket } = createFakeBucket();
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add((await createDraft(bucket, SOURCE, "same text")).draftId);

    // Same text every time: the id must not be derived from content, or it
    // would both collide and leak what it was derived from.
    expect(ids.size).toBe(50);
  });

  it("does not build the id out of the message", async () => {
    const { bucket } = createFakeBucket();
    const draft = await createDraft(bucket, SOURCE, "kunsthaus");

    expect(draft.draftId).not.toContain("kunsthaus");
    expect(draft.draftId).toMatch(/^[0-9abcdefghjkmnpqrstvwxyz]{16}$/);
  });

  it("propagates a storage failure instead of returning a draft that was never written", async () => {
    const { bucket, failNextPut } = createFakeBucket();
    failNextPut("R2 unavailable");

    await expect(createDraft(bucket, SOURCE, "a morning run")).rejects.toThrow("R2 unavailable");
  });
});

describe("loadDraft", () => {
  it("round-trips a stored draft", async () => {
    const { bucket } = createFakeBucket();
    const created = await createDraft(bucket, SOURCE, "a morning run");

    expect(await loadDraft(bucket, created.draftId)).toEqual(created);
  });

  it("returns null for a draft that does not exist", async () => {
    const { bucket } = createFakeBucket();
    expect(await loadDraft(bucket, "aaaaaaaaaaaaaaaa")).toBeNull();
  });

  it("returns null rather than throwing on an unreadable object", async () => {
    const { bucket, objects } = createFakeBucket();
    objects.set(draftKey("aaaaaaaaaaaaaaaa"), "{not json");

    expect(await loadDraft(bucket, "aaaaaaaaaaaaaaaa")).toBeNull();
  });

  it("returns null when the stored object is not shaped like a draft", async () => {
    const { bucket, objects } = createFakeBucket();
    objects.set(draftKey("aaaaaaaaaaaaaaaa"), JSON.stringify({ hello: "world" }));

    expect(await loadDraft(bucket, "aaaaaaaaaaaaaaaa")).toBeNull();
  });

  it("refuses an id that could name a different object", async () => {
    const { bucket } = createFakeBucket();

    // A draft id reaches this from a callback token, so it is not trusted to
    // stay inside the drafts/ prefix on its own.
    for (const id of ["../../originals/secret", "a/../../x", "aaa", "AAAAAAAAAAAAAAAA", ""]) {
      expect(await loadDraft(bucket, id)).toBeNull();
    }
  });
});

describe("saveDraft", () => {
  it("overwrites the draft in place", async () => {
    const { bucket, objects } = createFakeBucket();
    const draft = await createDraft(bucket, SOURCE, "a morning run");

    const edited: Draft = { ...draft, state: "awaiting_approval", input: { text: "an evening run" } };
    await saveDraft(bucket, edited);

    expect(objects.size).toBe(1);
    expect(await loadDraft(bucket, draft.draftId)).toEqual(edited);
  });
});
