import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chunkKey } from "../content/chunks";
import { MANIFEST_KEY, type Manifest } from "../content/manifest";
import type { PublicRecord } from "../content/records";
import { takePending } from "../drafts/pending";
import { createFakeBucket, type FakeBucket } from "../test-support/r2";
import type { TelegramCallbackQuery } from "../telegram/types";
import {
  applyEditTarget,
  applyEditValue,
  handleEditCallback,
  isEditCallback,
  promptForEdit,
} from "./edit-activity";

let storage: FakeBucket;
let content: FakeBucket;
let calls: Array<{ method: string; body: Record<string, unknown> }>;

const CHAT = 99;
const RECORD = "aaaaaaaaaaaaaaaa";

function env() {
  return {
    PRIVATE_BUCKET: storage.bucket,
    CONTENT_BUCKET: content.bucket,
    TELEGRAM_BOT_TOKEN: "test-token",
    SITE_BASE_URL: "https://site.example",
  };
}

function record(overrides: Partial<PublicRecord> = {}): PublicRecord {
  return {
    id: RECORD,
    title: "A morning run",
    summary: "A short run before work.",
    body: "Eight kilometres before work.",
    eventDate: "2026-08-10",
    publishedAt: "2026-08-10T09:00:00.000Z",
    tags: ["Running"],
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

function press(data: string): TelegramCallbackQuery {
  return {
    id: "cb-1",
    from: { id: 42 },
    data,
    message: { message_id: 7, date: 0, chat: { id: CHAT, type: "private" } },
  };
}

function sent(): string[] {
  return calls.filter((c) => c.method === "sendMessage").map((c) => String(c.body.text));
}

function keyboardOf(index = -1): string[] {
  const call = calls.filter((c) => c.method === "sendMessage").at(index);
  return (
    (call?.body.reply_markup as { inline_keyboard?: Array<Array<{ callback_data: string }>> })
      ?.inline_keyboard ?? []
  )
    .flat()
    .map((button) => button.callback_data);
}

function manifest(): Manifest {
  return JSON.parse(content.objects.get(MANIFEST_KEY) as string) as Manifest;
}

function liveRecords(): PublicRecord[] {
  return manifest().records.flatMap(
    (entry) => JSON.parse(content.objects.get(chunkKey(entry.id)) as string) as PublicRecord[],
  );
}

/** The id the Save button carries, read off the last keyboard sent. */
function proposedId(): string {
  const save = keyboardOf().find((data) => data.startsWith("ea:y:"));
  if (save === undefined) throw new Error("no Save button was offered");
  return save.slice("ea:y:".length);
}

/** Picks a field and sends the new wording, as the intake would. */
async function change(field: string, text: string): Promise<void> {
  await handleEditCallback(press(`ea:f:${RECORD}:${field}`), env());
  const pending = await takePending(storage.bucket, CHAT);
  if (pending?.kind !== "edit-field") throw new Error("the chat was not armed for a value");
  await applyEditValue(env(), CHAT, pending.recordId, pending.field, text);
}

beforeEach(() => {
  storage = createFakeBucket();
  content = createFakeBucket();
  calls = [];

  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const method = new URL(String(url)).pathname.split("/").pop() ?? "";
    calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : {} });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 4242 } }), { status: 200 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isEditCallback", () => {
  it("claims its own namespace and nothing else", () => {
    expect(isEditCallback("ea:f:record:t")).toBe(true);
    expect(isEditCallback("ea:x")).toBe(true);
    expect(isEditCallback("da:y:record")).toBe(false);
    expect(isEditCallback("rm:p:record")).toBe(false);
    expect(isEditCallback("am:p:d:t:r")).toBe(false);
    expect(isEditCallback(undefined)).toBe(false);
  });
});

describe("choosing the activity", () => {
  beforeEach(() => publish([[record()]]));

  it("asks for a link and arms the chat so one can simply be sent", async () => {
    await promptForEdit(env(), CHAT);

    expect(sent().at(-1)).toContain("Send its link, its slug or its id");
    expect(await takePending(storage.bucket, CHAT)).toEqual({ kind: "edit-target" });
  });

  it("takes a pasted link and shows every field as it stands", async () => {
    await applyEditTarget(env(), CHAT, "https://site.example/activities/?v=a-morning-run");

    const shown = sent().at(-1) as string;
    expect(shown).toContain("Title: A morning run");
    expect(shown).toContain("Summary: A short run before work.");
    expect(shown).toContain("Text: Eight kilometres before work.");
    expect(shown).toContain("Date: 2026-08-10");
    expect(shown).toContain("Tags: Running");

    expect(keyboardOf()).toEqual([
      `ea:f:${RECORD}:t`,
      `ea:f:${RECORD}:b`,
      `ea:f:${RECORD}:s`,
      `ea:f:${RECORD}:d`,
      `ea:f:${RECORD}:g`,
      "ea:x",
    ]);
  });

  /** The same reach the delete flow has: every other one stops three chunks back. */
  it("finds an activity far older than the other flows look", async () => {
    publish([
      [record({ id: "oooooooooooooooo", title: "The oldest thing here" })],
      [record({ id: "bbbbbbbbbbbbbbbb" })],
      [record({ id: "cccccccccccccccc" })],
      [record({ id: "dddddddddddddddd" })],
      [record()],
    ]);

    await applyEditTarget(env(), CHAT, "oooooooooooooooo");

    expect(sent().at(-1)).toContain("The oldest thing here");
  });

  it("re-arms the chat when nothing matches", async () => {
    await applyEditTarget(env(), CHAT, "zzzzzzzzzzzzzzzz");

    expect(sent().at(-1)).toContain("could not find an activity");
    expect(await takePending(storage.bucket, CHAT)).toEqual({ kind: "edit-target" });
  });

  it("says so when nothing is published", async () => {
    publish([]);
    await promptForEdit(env(), CHAT);

    expect(sent().at(-1)).toContain("nothing to change");
    expect(await takePending(storage.bucket, CHAT)).toBeNull();
  });
});

describe("picking a field", () => {
  beforeEach(() => publish([[record()]]));

  it("reads the field back and arms the chat for the replacement", async () => {
    await handleEditCallback(press(`ea:f:${RECORD}:b`), env());

    expect(sent().at(-1)).toContain("Text now reads:");
    expect(sent().at(-1)).toContain("Eight kilometres before work.");
    expect(await takePending(storage.bucket, CHAT)).toEqual({
      kind: "edit-field",
      recordId: RECORD,
      field: "body",
    });
  });

  it("offers to empty a field that can be emptied", async () => {
    await handleEditCallback(press(`ea:f:${RECORD}:s`), env());
    expect(keyboardOf()).toEqual([`ea:c:${RECORD}:s`, "ea:x"]);
  });

  /** The site has nothing to head the page with, so this one is never offered. */
  it("does not offer to empty the title", async () => {
    await handleEditCallback(press(`ea:f:${RECORD}:t`), env());
    expect(keyboardOf()).toEqual(["ea:x"]);
  });

  it("says the date wants a shape, because one is not obvious", async () => {
    await handleEditCallback(press(`ea:f:${RECORD}:d`), env());
    expect(sent().at(-1)).toContain("YYYY-MM-DD");
  });

  it("refuses a button naming a field that is not one", async () => {
    await handleEditCallback(press(`ea:f:${RECORD}:z`), env());
    expect(sent().at(-1)).toContain("could not find that activity");
  });
});

describe("proposing the change", () => {
  beforeEach(() => publish([[record()]]));

  it("shows what the field would say, and changes nothing yet", async () => {
    await change("b", "Eight kilometres, in the rain.");

    expect(sent().at(-1)).toContain('Text of "A morning run" would become:');
    expect(sent().at(-1)).toContain("Eight kilometres, in the rain.");
    expect(liveRecords()[0].body).toBe("Eight kilometres before work.");
  });

  /**
   * The author is mid-sentence about one field. Their corrected attempt becoming
   * a brand-new activity would be the worst possible answer to "that is too
   * long".
   */
  it("re-arms the chat when the value is refused", async () => {
    await handleEditCallback(press(`ea:f:${RECORD}:t`), env());
    const pending = await takePending(storage.bucket, CHAT);
    if (pending?.kind !== "edit-field") throw new Error("expected an armed chat");

    await applyEditValue(env(), CHAT, pending.recordId, pending.field, "x".repeat(200));

    expect(sent().at(-1)).toContain("Shorten it");
    expect(await takePending(storage.bucket, CHAT)).toEqual({
      kind: "edit-field",
      recordId: RECORD,
      field: "title",
    });
  });
});

describe("saving", () => {
  beforeEach(() => publish([[record(), record({ id: "bbbbbbbbbbbbbbbb", title: "A note" })]]));

  it("writes the new wording and links to it", async () => {
    await change("b", "Eight kilometres, in the rain.");
    await handleEditCallback(press(`ea:y:${proposedId()}`), env());

    expect(liveRecords()[0].body).toBe("Eight kilometres, in the rain.");
    expect(sent().at(-1)).toContain('Changed the text of "A morning run"');
    expect(sent().at(-1)).toContain("https://site.example/activities/?v=a-morning-run");
  });

  it("leaves every other field and every other activity as they were", async () => {
    await change("b", "Something else entirely.");
    await handleEditCallback(press(`ea:y:${proposedId()}`), env());

    const [changed, untouched] = liveRecords();
    expect(changed.title).toBe("A morning run");
    expect(changed.summary).toBe("A short run before work.");
    expect(changed.tags).toEqual(["Running"]);
    expect(changed.publishedAt).toBe("2026-08-10T09:00:00.000Z");
    expect(untouched.title).toBe("A note");
  });

  it("republishes the chunk rather than editing it", async () => {
    await change("t", "A rainy morning run");
    await handleEditCallback(press(`ea:y:${proposedId()}`), env());

    const original = JSON.parse(content.objects.get(chunkKey("chunk0")) as string) as PublicRecord[];
    expect(original[0].title).toBe("A morning run");
    expect(manifest().records[0].id).not.toBe("chunk0");
  });

  /** The slug comes from the title, so renaming moves the page. */
  it("warns that a renamed activity has a new link", async () => {
    await change("t", "A rainy morning run");
    await handleEditCallback(press(`ea:y:${proposedId()}`), env());

    expect(sent().at(-1)).toContain("?v=a-rainy-morning-run");
    expect(sent().at(-1)).toContain("older one no longer finds it");
  });

  it("empties a field on the Clear button", async () => {
    await handleEditCallback(press(`ea:c:${RECORD}:s`), env());
    await handleEditCallback(press(`ea:y:${proposedId()}`), env());

    expect(liveRecords()[0].summary).toBeNull();
    expect(sent().at(-1)).toContain('Changed the summary of "A morning run"');
  });

  it("saves a new tag list", async () => {
    await change("g", "Running, Rain, Morning");
    await handleEditCallback(press(`ea:y:${proposedId()}`), env());

    expect(liveRecords()[0].tags).toEqual(["Running", "Rain", "Morning"]);
  });

  /**
   * The proposal stores the value, never a finished record, so anything that
   * landed between the preview and the press survives it.
   */
  it("keeps a photo added while the preview was on screen", async () => {
    await change("b", "Eight kilometres, in the rain.");

    const withMedia = record({
      media: [{ type: "image", src: "https://media.test/a.webp", alt: null, caption: null }],
    });
    publish([[withMedia, record({ id: "bbbbbbbbbbbbbbbb", title: "A note" })]]);

    await handleEditCallback(press(`ea:y:${proposedId()}`), env());

    const [changed] = liveRecords();
    expect(changed.body).toBe("Eight kilometres, in the rain.");
    expect(changed.media).toHaveLength(1);
  });

  it("says so when the wording is already what it says", async () => {
    await change("b", "Eight kilometres before work.");
    await handleEditCallback(press(`ea:y:${proposedId()}`), env());

    expect(sent().at(-1)).toContain("already what it says");
    expect(manifest().records[0].id).toBe("chunk0");
  });

  /** A proposal is consumed by the press that saves it, so the second finds nothing. */
  it("is harmless when the same Save is pressed twice", async () => {
    await change("b", "Eight kilometres, in the rain.");
    const editId = proposedId();

    await handleEditCallback(press(`ea:y:${editId}`), env());
    const after = content.objects.size;
    await handleEditCallback(press(`ea:y:${editId}`), env());

    expect(sent().at(-1)).toContain("no longer available");
    expect(content.objects.size).toBe(after);
  });

  /**
   * Two edits started in a row must not share a key. Sharing one would have the
   * older message's Save apply the *newer* change — the author reading one
   * screenful and saving a different one. Each button does what its own message
   * says instead, which is the rule the remove-media buttons follow too.
   */
  it("keeps two proposals apart, each doing what its own message says", async () => {
    await change("t", "First attempt");
    const first = proposedId();
    await change("t", "Second attempt");
    const second = proposedId();

    expect(first).not.toBe(second);

    await handleEditCallback(press(`ea:y:${second}`), env());
    expect(liveRecords()[0].title).toBe("Second attempt");

    // The older button puts back the wording its own message showed, rather
    // than re-applying the newer one.
    await handleEditCallback(press(`ea:y:${first}`), env());
    expect(liveRecords()[0].title).toBe("First attempt");
  });

  it("says so when the activity went while the preview was on screen", async () => {
    await change("b", "Eight kilometres, in the rain.");
    publish([[record({ id: "bbbbbbbbbbbbbbbb", title: "A note" })]]);

    await handleEditCallback(press(`ea:y:${proposedId()}`), env());

    expect(sent().at(-1)).toContain("could not find that activity");
  });

  it("leaves the site as it was when the chunk cannot be written", async () => {
    await change("b", "Eight kilometres, in the rain.");
    content.failPutsFor((key) => key !== MANIFEST_KEY);

    await handleEditCallback(press(`ea:y:${proposedId()}`), env());

    expect(sent().at(-1)).toContain("still says what it said");
    expect(liveRecords()[0].body).toBe("Eight kilometres before work.");
  });

  it("cancels without touching anything", async () => {
    await change("b", "Eight kilometres, in the rain.");
    await handleEditCallback(press("ea:x"), env());

    expect(sent().at(-1)).toBe("Nothing was changed.");
    expect(liveRecords()[0].body).toBe("Eight kilometres before work.");
    expect(await takePending(storage.bucket, CHAT)).toBeNull();
  });
});
