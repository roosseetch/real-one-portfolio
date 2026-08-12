import { beforeEach, describe, expect, it } from "vitest";

import { createFakeBucket, type FakeBucket } from "../test-support/r2";
import { createState, takeState } from "./state";

let storage: FakeBucket;

beforeEach(() => {
  storage = createFakeBucket();
});

const CHAT = 99;
const RECORD = "k3m9qq2vabcd1234";

describe("createState", () => {
  it("mints a state that names the chat and the waiting activity", async () => {
    const state = await createState(storage.bucket, CHAT, RECORD);
    expect(state).not.toBeNull();

    const taken = await takeState(storage.bucket, state!);
    expect(taken).toEqual({ chatId: CHAT, recordId: RECORD, expiresAt: expect.any(String) });
  });

  it("carries a null activity for a login started on its own", async () => {
    const state = await createState(storage.bucket, CHAT, null);
    expect((await takeState(storage.bucket, state!))?.recordId).toBeNull();
  });

  it("stores it under drafts/, where the seven-day rule sweeps the abandoned ones", async () => {
    const state = await createState(storage.bucket, CHAT, RECORD);
    expect(storage.objects.has(`drafts/linkedin-state/${state}.json`)).toBe(true);
  });
});

describe("takeState", () => {
  it("spends it: the second attempt gets nothing", async () => {
    const state = await createState(storage.bucket, CHAT, RECORD);

    expect(await takeState(storage.bucket, state!)).not.toBeNull();
    expect(await takeState(storage.bucket, state!)).toBeNull();
  });

  it("refuses one that has expired", async () => {
    const minted = new Date("2026-08-12T10:00:00.000Z");
    const state = await createState(storage.bucket, CHAT, RECORD, minted);

    const later = new Date("2026-08-12T10:16:00.000Z");
    expect(await takeState(storage.bucket, state!, later)).toBeNull();
  });

  it("refuses one that was never minted", async () => {
    expect(await takeState(storage.bucket, "k3m9qq2vabcd1234abcd1234")).toBeNull();
  });

  it("refuses a shape that could name a different prefix", async () => {
    // It arrives as a query parameter from the open internet and is about to
    // become an object key.
    expect(await takeState(storage.bucket, "../../linkedin/token")).toBeNull();
    expect(await takeState(storage.bucket, "")).toBeNull();
  });

  it("refuses an object that is not a state", async () => {
    storage.objects.set("drafts/linkedin-state/k3m9qq2vabcd1234abcd1234.json", "not json");
    expect(await takeState(storage.bucket, "k3m9qq2vabcd1234abcd1234")).toBeNull();
  });

  /**
   * The claim is a conditional write rather than a read followed by a delete.
   * A browser that prefetches the redirect, or a reload of the callback URL,
   * would otherwise pass the read twice and post the same activity to LinkedIn
   * twice — and a duplicate public post is not something an apology undoes.
   */
  it("lets only one of two racing claims through", async () => {
    const state = await createState(storage.bucket, CHAT, RECORD);

    const [first, second] = await Promise.all([
      takeState(storage.bucket, state!),
      takeState(storage.bucket, state!),
    ]);

    expect([first, second].filter((claim) => claim !== null)).toHaveLength(1);
  });
});
