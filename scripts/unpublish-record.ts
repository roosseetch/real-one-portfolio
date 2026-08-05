/**
 * Removes a published record from the site.
 *
 * Chunks are immutable, so this is a rewrite rather than a delete: the chunk
 * holding the record is republished under a new id without it, and the manifest
 * is repointed. The superseded chunk is left in place, unreferenced — exactly
 * what publication itself does when appending, and what lets every chunk be
 * cached for a year without ever going stale.
 *
 * The manifest is written last. A record that has disappeared from a chunk the
 * manifest still points at would be a broken site; a chunk nothing points at is
 * merely invisible.
 *
 * Usage:
 *   set -a; . ./infrastructure/.env; . ./worker/.env; set +a
 *   npx tsx scripts/unpublish-record.ts <record-id>
 *
 * Exit code 0 = removed, 1 = not found or failure.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MANIFEST_KEY = "content/manifest.json";
const MANIFEST_CACHE_CONTROL = "no-cache";
const CHUNK_CACHE_CONTROL = "public, max-age=31536000, immutable";
const CHUNK_ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

interface ManifestEntry {
  id: string;
  sha256: string;
  count: number;
}

interface Manifest {
  schemaVersion: number;
  updatedAt: string;
  recordsPerFile: number;
  totalRecords: number;
  records: ManifestEntry[];
  latest: string | null;
}

interface PublicRecord {
  id: string;
  title: string;
}

const recordId = process.argv[2];
const bucket = process.env.CONTENT_BUCKET;
const base = process.env.CONTENT_BASE_URL?.replace(/\/$/, "");
const apiToken = process.env.CLOUDFLARE_API_TOKEN;

const missing = Object.entries({ CONTENT_BUCKET: bucket, CONTENT_BASE_URL: base, CLOUDFLARE_API_TOKEN: apiToken })
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (!recordId || missing.length > 0) {
  console.error("Cannot remove the record.");
  if (!recordId) console.error("  no record id given");
  for (const name of missing) console.error(`  ${name} is not set`);
  console.error("\nUsage: npx tsx scripts/unpublish-record.ts <record-id>");
  console.error("CONTENT_BUCKET and CONTENT_BASE_URL live in worker/.env,");
  console.error("CLOUDFLARE_API_TOKEN in infrastructure/.env.");
  process.exit(1);
}

function randomChunkId(length = 12): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => CHUNK_ID_ALPHABET[byte % CHUNK_ID_ALPHABET.length]).join("");
}

/** Read over the public domain: no credentials needed, and it sees exactly what a visitor sees. */
async function readJson<T>(path: string): Promise<T> {
  const response = await fetch(`${base}/${path}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`);
  return (await response.json()) as T;
}

function put(key: string, body: string, cacheControl: string): void {
  const file = join(mkdtempSync(join(tmpdir(), "unpublish-")), "object.json");
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

const manifest = await readJson<Manifest>(MANIFEST_KEY);

// Find the chunk holding it before changing anything.
let holder: ManifestEntry | null = null;
let remaining: PublicRecord[] = [];

for (const entry of manifest.records) {
  const records = await readJson<PublicRecord[]>(`content/records-${entry.id}.json`);
  if (records.some((record) => record.id === recordId)) {
    holder = entry;
    remaining = records.filter((record) => record.id !== recordId);
    break;
  }
}

if (holder === null) {
  console.error(`No published chunk contains a record with id ${recordId}.`);
  process.exit(1);
}

let entries: ManifestEntry[];

if (remaining.length === 0) {
  // Nothing left to point at, so the entry goes rather than an empty chunk
  // being published.
  entries = manifest.records.filter((entry) => entry.id !== holder.id);
  console.log(`  chunk ${holder.id} held only that record; its entry is removed`);
} else {
  const body = `${JSON.stringify(remaining, null, 2)}`;
  const chunkId = randomChunkId();
  put(`content/records-${chunkId}.json`, body, CHUNK_CACHE_CONTROL);
  const sha256 = createHash("sha256").update(body).digest("hex");
  entries = manifest.records.map((entry) =>
    entry.id === holder.id ? { id: chunkId, sha256, count: remaining.length } : entry,
  );
  console.log(`  chunk ${holder.id} republished as ${chunkId} without it`);
}

const updated: Manifest = {
  ...manifest,
  updatedAt: new Date().toISOString(),
  totalRecords: entries.reduce((sum, entry) => sum + entry.count, 0),
  records: entries,
  // The newest chunk is the last one; null once nothing is published at all.
  latest: entries.length === 0 ? null : entries[entries.length - 1].id,
};

put(MANIFEST_KEY, `${JSON.stringify(updated, null, 2)}\n`, MANIFEST_CACHE_CONTROL);

console.log(`Removed ${recordId}. ${updated.totalRecords} record(s) remain.`);
console.log(`The superseded chunk ${holder.id} is left unreferenced; the lifecycle does not touch public content.`);
