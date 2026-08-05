import { describe, expect, it } from "vitest";

import { aiRecord, createFakeAi } from "../test-support/ai";
import { generateRecord } from "./generate";

const NOTE = "went for an easy 8k along the river before work";

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

  it("honours a smaller attempt budget", async () => {
    const fake = createFakeAi({ response: "{not json" });
    await generateRecord({ AI: fake.AI }, NOTE, new Date(), 1);

    expect(fake.calls).toHaveLength(1);
  });
});
