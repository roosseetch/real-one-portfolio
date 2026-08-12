import { describe, expect, it } from "vitest";

import type { DraftRecord } from "../drafts/types";
import { ACTION_CODES, formatPreview, generationKeyboard, previewKeyboard } from "./preview";

const RECORD: DraftRecord = {
  title: "Morning run by the river",
  summary: "An easy 8 km before work.",
  body: "Cool air, quiet paths, and a good pace.",
  eventDate: "2026-07-28",
  tags: ["Jogging", "Outdoors"],
  media: [],
};

describe("formatPreview", () => {
  it("asks the approval question spec §7.2 specifies", () => {
    expect(formatPreview(RECORD)).toContain("Is this the information and media that should become public?");
  });

  it("shows every field that would become public", () => {
    const text = formatPreview(RECORD);
    for (const value of [RECORD.title, RECORD.summary!, RECORD.body!, "2026-07-28", "Jogging, Outdoors"]) {
      expect(text).toContain(value);
    }
  });

  it("shows the body in full rather than summarising it", () => {
    // The whole point of the preview is that approving it is informed.
    const long = { ...RECORD, body: "x".repeat(1500) };
    expect(formatPreview(long)).toContain("x".repeat(1500));
  });

  it("marks absent fields rather than dropping their labels", () => {
    // A missing summary must look missing, not look like it was never asked for.
    const bare: DraftRecord = { ...RECORD, summary: null, body: null, eventDate: null, tags: [] };
    const text = formatPreview(bare);
    for (const label of ["Title", "Date", "Summary", "Body", "Tags"]) expect(text).toContain(label);
    expect(text.match(/—/g)).toHaveLength(4);
  });

  it("stays inside Telegram's message limit and says when it truncated", () => {
    // Telegram rejects an oversized sendMessage outright, so an un-truncated
    // preview would mean no preview at all.
    const text = formatPreview({ ...RECORD, body: "y".repeat(9000) });
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toContain("Preview truncated");
  });

  it("emits no markup that a stray character in generated prose could break", () => {
    // Sent with no parse_mode, so these are shown literally rather than
    // rendered — and cannot make the send fail.
    const text = formatPreview({ ...RECORD, body: "a *bold* claim about _me_ <b>and</b> [links](x)" });
    expect(text).toContain("a *bold* claim about _me_ <b>and</b> [links](x)");
  });

  it("says nothing about media for a note that never carried any", () => {
    expect(formatPreview(RECORD)).not.toContain("Media");
  });

  it("says publishing posts the text alone when the attachment was refused", () => {
    // Approving a preview that reads exactly like a note's is how a record went
    // live describing a video it does not contain.
    const text = formatPreview(RECORD, true);
    expect(text).toContain("Media");
    expect(text).toContain("posts the text on its own");
  });

  it("keeps the notice inside the message limit", () => {
    // The notice is appended after the body, so it is the part a long entry
    // would push out — and it is the part that must not be lost.
    const text = formatPreview({ ...RECORD, body: "y".repeat(9000) }, true);
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toContain("Preview truncated");
  });
});

describe("previewKeyboard", () => {
  it("offers exactly the five buttons spec §7.2 lists", () => {
    const labels = previewKeyboard("abc123def456ghjk", "tok123456789")
      .inline_keyboard.flat()
      .map((button) => button.text);

    expect(labels).toEqual(["Publish", "Edit text", "Change media", "Regenerate", "Cancel"]);
  });

  it("fits callback_data inside Telegram's 64-byte limit", () => {
    // A 16-character draft id and a 12-character token leave little room; if
    // either grows, this is where it gets noticed.
    for (const button of previewKeyboard("abc123def456ghjk", "tok123456789").inline_keyboard.flat()) {
      expect(new TextEncoder().encode(button.callback_data).length).toBeLessThanOrEqual(64);
    }
  });

  it("carries the draft id and token on every button", () => {
    for (const button of previewKeyboard("abc123def456ghjk", "tok123456789").inline_keyboard.flat()) {
      const [code, draftId, token] = button.callback_data.split(":");
      expect(ACTION_CODES[code]).toBeDefined();
      expect(draftId).toBe("abc123def456ghjk");
      expect(token).toBe("tok123456789");
    }
  });
});

describe("generationKeyboard", () => {
  const keyboard = () => generationKeyboard("abc123def456ghjk", "tok123456789").inline_keyboard.flat();

  it("offers another attempt and nothing that needs a record", () => {
    expect(keyboard().map((button) => button.text)).toEqual(["Try again", "Cancel"]);
  });

  it("does not carry the code that publishes", () => {
    // The failure keyboard's Retry runs a publication. A record-less draft must
    // not be able to reach that, so the two keyboards use different codes.
    const codes = keyboard().map((button) => button.callback_data.split(":")[0]);

    expect(codes).toContain("g");
    expect(codes).not.toContain("t");
  });

  it("fits callback_data inside Telegram's 64-byte limit", () => {
    for (const button of keyboard()) {
      expect(new TextEncoder().encode(button.callback_data).length).toBeLessThanOrEqual(64);
    }
  });
});
