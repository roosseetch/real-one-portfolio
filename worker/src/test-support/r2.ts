/**
 * An in-memory stand-in for an R2 bucket, covering the handful of operations
 * the Worker actually uses — including the conditional writes the manifest
 * depends on, since that concurrency path is the one most worth testing.
 *
 * Not a test file itself — vitest only collects *.test.ts — but it lives under
 * src/ so the existing tsconfig typechecks it, and nothing in the entry graph
 * imports it, so wrangler never bundles it.
 */

interface StoredObject {
  body: string;
  etag: string;
  cacheControl?: string;
}

export interface FakeBucket {
  bucket: R2Bucket;
  /** Stored object bodies, keyed by object name. */
  objects: Map<string, string>;
  /** Cache-Control recorded per object, so the published headers can be asserted. */
  cacheControl(key: string): string | undefined;
  /** Makes the next put throw, for exercising the storage-failure path. */
  failNextPut(message?: string): void;
  /**
   * Runs once, just before the next put of `key` — the seam for simulating
   * another publication landing between a read and its conditional write.
   */
  interceptPut(key: string, action: () => void | Promise<void>): void;
}

export function createFakeBucket(): FakeBucket {
  const stored = new Map<string, StoredObject>();
  let pendingFailure: string | null = null;
  let interception: { key: string; action: () => void | Promise<void> } | null = null;
  let etagCounter = 0;

  /** A body-independent tag, so rewriting identical content still changes it. */
  const nextEtag = () => `etag-${++etagCounter}`;

  const bucket = {
    async put(key: string, value: string, options?: R2PutOptions) {
      if (pendingFailure !== null) {
        const message = pendingFailure;
        pendingFailure = null;
        throw new Error(message);
      }

      if (interception !== null && interception.key === key) {
        const { action } = interception;
        interception = null;
        await action();
      }

      const condition = options?.onlyIf as R2Conditional | undefined;
      const current = stored.get(key);

      if (condition?.etagMatches !== undefined && current?.etag !== condition.etagMatches) {
        // R2 reports a failed precondition by returning null, not by throwing.
        return null;
      }
      if (condition?.etagDoesNotMatch === "*" && current !== undefined) {
        return null;
      }

      const metadata = options?.httpMetadata as R2HTTPMetadata | undefined;
      const etag = nextEtag();
      stored.set(key, { body: value, etag, cacheControl: metadata?.cacheControl });
      return { key, etag };
    },

    async get(key: string) {
      const object = stored.get(key);
      if (object === undefined) return null;
      return {
        key,
        etag: object.etag,
        text: async () => object.body,
        json: async () => JSON.parse(object.body),
      };
    },

    async delete(key: string) {
      stored.delete(key);
    },
  };

  // A Map view over the bodies, so existing tests keep reading `objects`
  // without knowing about etags.
  const objects = {
    get size() {
      return stored.size;
    },
    has: (key: string) => stored.has(key),
    get: (key: string) => stored.get(key)?.body,
    set: (key: string, body: string) => {
      stored.set(key, { body, etag: nextEtag() });
      return objects;
    },
    keys: () => stored.keys(),
    [Symbol.iterator]: () => stored.keys(),
  } as unknown as Map<string, string>;

  return {
    // The Worker touches put, get and delete; asserting the full R2Bucket
    // surface here would be scaffolding nothing reads.
    bucket: bucket as unknown as R2Bucket,
    objects,
    cacheControl: (key: string) => stored.get(key)?.cacheControl,
    failNextPut(message = "R2 unavailable") {
      pendingFailure = message;
    },
    interceptPut(key: string, action: () => void | Promise<void>) {
      interception = { key, action };
    },
  };
}
