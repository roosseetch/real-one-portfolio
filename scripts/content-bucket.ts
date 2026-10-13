/**
 * What the two hand-run content scripts share: the manifest's shape, reading
 * the bucket the way a visitor does, and writing to it through wrangler.
 *
 * The Worker has its own copy of the shapes (worker/src/content/), which this
 * deliberately does not import: the scripts resolve as NodeNext and the Worker
 * as a bundler, and a cross-tree import would tie a one-off script's build to
 * the Worker's.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MANIFEST_KEY = "content/manifest.json";
export const MANIFEST_CACHE_CONTROL = "no-cache";
export const CHUNK_CACHE_CONTROL = "public, max-age=31536000, immutable";
/** worker/src/content/manifest.ts: RECORDS_PER_FILE. */
export const RECORDS_PER_FILE = 10;

/** Crockford base32, as worker/src/ids.ts spells it. */
const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export interface ManifestEntry {
  id: string;
  sha256: string;
  count: number;
}

export interface Manifest {
  schemaVersion: number;
  updatedAt: string;
  recordsPerFile: number;
  totalRecords: number;
  records: ManifestEntry[];
  latest: string | null;
}

export interface PublicRecord {
  id: string;
  title: string;
  [field: string]: unknown;
}

export function randomId(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("");
}

/** Read over the public domain: no credentials needed, and it sees exactly what a visitor sees. */
export async function readJson<T>(base: string, path: string): Promise<T> {
  const response = await fetch(`${base}/${path}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`);
  return (await response.json()) as T;
}

export function put(bucket: string, key: string, body: string, cacheControl: string): void {
  const file = join(mkdtempSync(join(tmpdir(), "content-")), "object.json");
  writeFileSync(file, body);
  execFileSync(
    "npx",
    [
      "wrangler",
      "r2",
      "object",
      "put",
      `${bucket}/${key}`,
      `--file=${file}`,
      "--content-type=application/json",
      `--cache-control=${cacheControl}`,
      "--remote",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: process.env },
  );
}

/**
 * The manifest after one record has been added, given the chunk it went into.
 *
 * The arithmetic of worker/src/publishing/publish.ts (nextManifest): a chunk
 * that was not full is replaced by its successor in place, and a full one —
 * or no chunk at all — means the new chunk joins the end of the list.
 */
export function manifestWith(manifest: Manifest, entry: ManifestEntry, rolled: boolean, now: Date): Manifest {
  const records = rolled
    ? [...manifest.records, entry]
    : manifest.records.map((existing) => (existing.id === manifest.latest ? entry : existing));
  return {
    ...manifest,
    updatedAt: now.toISOString(),
    recordsPerFile: RECORDS_PER_FILE,
    totalRecords: records.reduce((sum, chunk) => sum + chunk.count, 0),
    records,
    latest: entry.id,
  };
}

/** Whether a new record starts a new chunk rather than joining the latest. */
export function rolls(manifest: Manifest): boolean {
  const latest = manifest.records.find((chunk) => chunk.id === manifest.latest) ?? null;
  return latest === null || latest.count >= RECORDS_PER_FILE;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const RECORD_ID = /^[0-9a-hjkmnp-tv-z]{16}$/;

/**
 * What is wrong with a record written by hand, as sentences; empty when
 * nothing is.
 *
 * The Worker never publishes anything it did not build itself, so it never had
 * to check a record. A file somebody typed is different, and the site drops a
 * record without a string id and title without saying why.
 */
export function problemsWith(record: unknown): string[] {
  if (typeof record !== "object" || record === null || Array.isArray(record)) return ["the file is not one JSON object"];
  const r = record as Record<string, unknown>;
  const problems: string[] = [];

  if (typeof r.title !== "string" || r.title.trim() === "") problems.push("title must be a non-empty string");
  for (const field of ["summary", "body"]) {
    if (r[field] !== undefined && r[field] !== null && typeof r[field] !== "string") {
      problems.push(`${field} must be a string or null`);
    }
  }
  if (r.eventDate !== undefined && r.eventDate !== null && !(typeof r.eventDate === "string" && ISO_DAY.test(r.eventDate))) {
    problems.push("eventDate must be YYYY-MM-DD or null");
  }
  if (r.bodyFormat !== undefined && r.bodyFormat !== "markdown") problems.push('bodyFormat, if given, must be "markdown"');
  if (r.tags !== undefined && !(Array.isArray(r.tags) && r.tags.every((tag) => typeof tag === "string"))) {
    problems.push("tags must be a list of strings");
  }
  if (r.media !== undefined) {
    if (!Array.isArray(r.media)) problems.push("media must be a list");
    else
      r.media.forEach((item, index) => {
        const m = item as Record<string, unknown>;
        if (m?.type !== "image" && m?.type !== "video") problems.push(`media[${index}].type must be image or video`);
        if (typeof m?.src !== "string" || !m.src.startsWith("https://")) problems.push(`media[${index}].src must be an https URL`);
      });
  }
  // Stamped here, never typed: these are the fields that say where a record is
  // and when it went live.
  for (const field of ["id", "publishedAt"]) {
    if (r[field] !== undefined) problems.push(`${field} is set by the script; leave it out of the file`);
  }
  return problems;
}

/** A record id as the Worker mints them (worker/src/ids.ts), so `--id` can be checked. */
export function isRecordId(value: string): boolean {
  return RECORD_ID.test(value);
}
