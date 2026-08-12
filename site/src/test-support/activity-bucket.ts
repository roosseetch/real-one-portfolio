/**
 * The public content bucket, stubbed, for the two suites that read it.
 *
 * The landing page's teaser and the /activities page load the same manifest and
 * the same chunks, so the bucket they load it from is built once here rather
 * than copied into both files and left to drift.
 *
 * No network anywhere: every response is a stub, and the content base URL comes
 * from vitest.config.ts the same way the deployed bundle takes it from the
 * build.
 */
import { expect, vi } from "vitest";

export const CONTENT_BASE = "https://content.test";

export interface TestRecord {
  id: string;
  title: string;
  publishedAt?: string | null;
  [key: string]: unknown;
}

/** A record with only what the loader requires, plus whatever a test adds. */
export const record = (title: string, extra: Partial<TestRecord> = {}): TestRecord => ({
  id: `id-${title}`,
  title,
  ...extra,
});

/**
 * Keys are object paths under content/; anything not listed answers 404, which
 * is what a manifest pointing at a chunk that was never written looks like.
 */
export function serve(objects: Record<string, unknown>) {
  const fetchStub = vi.fn(async (url: string) => {
    const path = String(url).replace(`${CONTENT_BASE}/`, "");
    if (!(path in objects)) return { ok: false, status: 404, json: async () => null };
    return { ok: true, status: 200, json: async () => objects[path] };
  });
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

/** A bucket holding one chunk per array given, and a manifest listing them. */
export function bucketOf(...chunks: unknown[][]): Record<string, unknown> {
  const objects: Record<string, unknown> = {};
  const records = chunks.map((chunk, i) => {
    objects[`content/records-chunk${i}.json`] = chunk;
    return { id: `chunk${i}` };
  });
  objects["content/manifest.json"] = { schemaVersion: 1, records };
  return objects;
}

/** Resolves once a loader has finished and taken its placeholders down. */
export async function loaded(section: HTMLElement) {
  await vi.waitFor(() => expect(section.querySelector(".activity-skeleton")).toBeNull());
}
