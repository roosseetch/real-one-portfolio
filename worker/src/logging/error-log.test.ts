import { describe, expect, it } from "vitest";

import { createFakeBucket } from "../test-support/r2";
import { beginRequest, flush, runWithLog, trackDeferred } from "./error-log";

const ctx = (): ExecutionContext =>
  ({ waitUntil: (promise: Promise<unknown>) => void promise, passThroughOnException: () => {} }) as ExecutionContext;

describe("deferred request logging", () => {
  it("records a rejected deferred task before flushing", async () => {
    const storage = createFakeBucket();
    const log = beginRequest(new Request("https://worker.example/telegram/webhook", { method: "POST" }));

    await runWithLog(log, async () => {
      const deferred = trackDeferred(ctx());
      deferred.context.waitUntil(Promise.reject(new Error("deferred draft load failed")));
      await deferred.settled();
      await flush(storage.bucket, log, 200);
    });

    const keys = [...storage.objects.keys()];
    expect(keys).toEqual([expect.stringMatching(/^logs\//)]);
    const written = JSON.parse(storage.objects.get(keys[0]) as string);
    expect(written.status).toBe(200);
    expect(written.entries).toContainEqual(
      expect.objectContaining({ level: "error", message: expect.stringContaining("deferred draft load failed") }),
    );
  });
});
