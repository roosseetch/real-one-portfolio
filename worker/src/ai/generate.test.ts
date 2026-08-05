import { describe, expect, it, vi } from "vitest";

import { aiRecord, createFakeAi } from "../test-support/ai";
import type { DraftRecord } from "../drafts/types";
import { editRecord, generateRecord, regenerateRecord } from "./generate";

const NOTE = "went for an easy 8k along the river before work";

const RECORD: DraftRecord = {
  title: "Morning run by the river",
  summary: "An easy 8 km before work.",
  body: "Cool air, quiet paths, and a good pace.",
  eventDate: "2026-07-28",
  tags: ["Jogging"],
  media: [],
};

describe("generateRecord", () => {
  it("returns the validated record", async () => {
    const { AI } = createFakeAi(aiRecord());
    const result = await generateRecord({ AI }, NOTE);

    expect(result).toEqual({
      status: "generated",
      record: {
        title: "Morning run by the river",
        summary: "An easy 8 km before work.",
        body: "Cool air, quiet paths, and a good pace.",
        eventDate: "2026-07-28",
        tags: ["Jogging"],
        media: [],
      },
    });
  });

  it("accepts a response the runtime already parsed", async () => {
    // The binding is typed as returning a string but hands back an object when
    // a schema constrains it. Both have to work.
    const { AI } = createFakeAi({ response: { title: "Morning run", tags: ["Jogging"] } });
    const result = await generateRecord({ AI }, NOTE);

    expect(result.status).toBe("generated");
  });

  it("constrains generation with the schema and passes the note through", async () => {
    const fake = createFakeAi(aiRecord());
    await generateRecord({ AI: fake.AI }, NOTE, new Date("2026-08-05T09:00:00Z"));

    const input = fake.calls[0].input as {
      messages: Array<{ role: string; content: string }>;
      response_format: { type: string };
    };
    expect(input.response_format.type).toBe("json_schema");
    expect(input.messages.at(-1)?.content).toContain(NOTE);
    // The model cannot resolve "yesterday" without knowing when now is.
    expect(input.messages.at(-1)?.content).toContain("2026-08-05");
  });

  it("retries malformed output and succeeds on a later attempt", async () => {
    const fake = createFakeAi({ response: "{not json" }, { response: { title: "" } }, aiRecord());
    const result = await generateRecord({ AI: fake.AI }, NOTE);

    expect(result.status).toBe("generated");
    expect(fake.calls).toHaveLength(3);
  });

  it("gives up after the attempt budget and says the output was unusable", async () => {
    const fake = createFakeAi({ response: "{not json" });
    const result = await generateRecord({ AI: fake.AI }, NOTE);

    expect(result).toEqual({ status: "unavailable", reason: "invalid" });
    expect(fake.calls).toHaveLength(3);
  });

  it("retries a transient failure", async () => {
    const fake = createFakeAi(new Error("connection reset"), aiRecord());
    const result = await generateRecord({ AI: fake.AI }, NOTE);

    expect(result.status).toBe("generated");
    expect(fake.calls).toHaveLength(2);
  });

  it("reports a model that never answered as an error, not as bad output", async () => {
    const fake = createFakeAi(new Error("connection reset"));
    const result = await generateRecord({ AI: fake.AI }, NOTE);

    expect(result).toEqual({ status: "unavailable", reason: "error" });
  });

  it("stops immediately when the allowance is exhausted", async () => {
    // Retrying an exhausted allowance only spends the author's time. The draft
    // is already saved, so this is recoverable tomorrow (spec §23).
    for (const message of [
      "Account limited: daily quota exceeded",
      "AI request failed: 429 Too Many Requests",
      "no capacity available for this model",
      "rate limit reached",
    ]) {
      const fake = createFakeAi(new Error(message));
      const result = await generateRecord({ AI: fake.AI }, NOTE);

      expect(result).toEqual({ status: "unavailable", reason: "quota" });
      expect(fake.calls).toHaveLength(1);
    }
  });

  it("runs hotter when regenerating than when generating", async () => {
    // Regenerate at the steady temperature would hand back something almost
    // identical, which reads as a broken button.
    const first = createFakeAi(aiRecord());
    const second = createFakeAi(aiRecord());
    await generateRecord({ AI: first.AI }, NOTE);
    await regenerateRecord({ AI: second.AI }, NOTE);

    const temp = (fake: typeof first) => (fake.calls[0].input as { temperature: number }).temperature;
    expect(temp(second)).toBeGreaterThan(temp(first));
  });

  it("shows the model what it already produced, so Regenerate changes something", async () => {
    // Temperature alone did not do it: constrained JSON decoding collapses the
    // variance, and a short note came back word-for-word identical however hot
    // it ran. The button has to tell the model what was rejected.
    const fake = createFakeAi(aiRecord());
    await regenerateRecord({ AI: fake.AI }, NOTE, RECORD);

    const prompt = (fake.calls[0].input as { messages: Array<{ content: string }> }).messages.at(-1)?.content ?? "";
    expect(prompt).toContain("Morning run by the river");
    expect(prompt).toContain("genuinely different");
  });

  it("still works for a first regeneration with nothing to avoid", async () => {
    const fake = createFakeAi(aiRecord());
    const result = await regenerateRecord({ AI: fake.AI }, NOTE, null);
    expect(result.status).toBe("generated");
  });

  it("honours a smaller attempt budget", async () => {
    const fake = createFakeAi({ response: "{not json" });
    await generateRecord({ AI: fake.AI }, NOTE, new Date(), 1);

    expect(fake.calls).toHaveLength(1);
  });
});

describe("editRecord", () => {
  it("returns the revised record", async () => {
    const { AI } = createFakeAi(aiRecord({ title: "Evening run by the river" }));
    const result = await editRecord({ AI }, RECORD, "call it an evening run");

    expect(result).toMatchObject({ status: "generated", record: { title: "Evening run by the river" } });
  });

  it("shows the model the current entry as data, plus the instruction", async () => {
    const fake = createFakeAi(aiRecord());
    await editRecord({ AI: fake.AI }, RECORD, "call it an evening run");

    const prompt = (fake.calls[0].input as { messages: Array<{ content: string }> }).messages.at(-1)?.content ?? "";
    expect(prompt).toContain("Morning run by the river");
    expect(prompt).toContain("call it an evening run");
    // Revising a structure it can see beats re-deriving one from a description.
    expect(prompt).toContain('"eventDate"');
  });

  it("never shows the model the media list", async () => {
    // The model does not decide media exists, and showing it a list invites
    // one back.
    const fake = createFakeAi(aiRecord());
    await editRecord({ AI: fake.AI }, { ...RECORD, media: [{ mediaId: "m1", alt: "a", caption: "c" }] }, "shorten it");

    const prompt = (fake.calls[0].input as { messages: Array<{ content: string }> }).messages.at(-1)?.content ?? "";
    expect(prompt).not.toContain("mediaId");
    expect(prompt).not.toContain("m1");
  });

  it("tells the model the instruction wins over its own judgement", async () => {
    const fake = createFakeAi(aiRecord());
    await editRecord({ AI: fake.AI }, RECORD, "shorten it");

    const system = (fake.calls[0].input as { messages: Array<{ content: string }> }).messages[0].content;
    expect(system).toContain("Change only what the instruction asks for");
  });

  it("reports an exhausted allowance without retrying", async () => {
    const fake = createFakeAi(new Error("daily quota exceeded"));
    const result = await editRecord({ AI: fake.AI }, RECORD, "shorten it");

    expect(result).toEqual({ status: "unavailable", reason: "quota" });
    expect(fake.calls).toHaveLength(1);
  });
});

describe("error logging", () => {
  it("reports why the model failed, without echoing the note back", async () => {
    // The first version logged only an attempt number, which made a real
    // production failure undiagnosable. This keeps the diagnosis and drops the
    // author's words.
    const warnings: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((m) => warnings.push(String(m)));

    const secret = "went for an easy 8k along the river before work";
    const fake = createFakeAi(new Error(`InferenceUpstreamError: model refused "${secret}"`));
    await generateRecord({ AI: fake.AI }, secret, new Date(), 1);

    warn.mockRestore();
    expect(warnings[0]).toContain("InferenceUpstreamError");
    expect(warnings[0]).not.toContain(secret);
    expect(warnings[0]).toContain("[prompt]");
  });
});

describe("author context in the prompts", () => {
  it("reaches both generation and editing", async () => {
    const forGeneration = createFakeAi(aiRecord());
    await generateRecord({ AI: forGeneration.AI }, NOTE);
    const editing = createFakeAi(aiRecord());
    await editRecord({ AI: editing.AI }, RECORD, "shorten it");

    for (const fake of [forGeneration, editing]) {
      const system = (fake.calls[0].input as { messages: Array<{ content: string }> }).messages[0].content;
      expect(system).toContain("in her own voice");
      // The profile must not become a quarry for details the note never had.
      expect(system).toContain("not a source of facts");
      // And the ban on inventing has to survive alongside it.
      expect(system).toMatch(/Never invent|never invent/);
    }
  });
});
