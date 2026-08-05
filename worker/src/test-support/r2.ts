/**
 * An in-memory stand-in for an R2 bucket, covering the handful of operations
 * the Worker actually uses.
 *
 * Not a test file itself — vitest only collects *.test.ts — but it lives under
 * src/ so the existing tsconfig typechecks it, and nothing in the entry graph
 * imports it, so wrangler never bundles it.
 */

export interface FakeBucket {
  bucket: R2Bucket;
  /** Stored object bodies, keyed by object name. */
  objects: Map<string, string>;
  /** Makes the next put throw, for exercising the storage-failure path. */
  failNextPut(message?: string): void;
}

export function createFakeBucket(): FakeBucket {
  const objects = new Map<string, string>();
  let pendingFailure: string | null = null;

  const bucket = {
    async put(key: string, value: string) {
      if (pendingFailure !== null) {
        const message = pendingFailure;
        pendingFailure = null;
        throw new Error(message);
      }
      objects.set(key, value);
      return { key };
    },

    async get(key: string) {
      const body = objects.get(key);
      if (body === undefined) return null;
      return {
        key,
        text: async () => body,
        json: async () => JSON.parse(body),
      };
    },

    async delete(key: string) {
      objects.delete(key);
    },
  };

  return {
    // The Worker touches put, get and delete; asserting the full R2Bucket
    // surface here would be scaffolding nothing reads.
    bucket: bucket as unknown as R2Bucket,
    objects,
    failNextPut(message = "R2 unavailable") {
      pendingFailure = message;
    },
  };
}
