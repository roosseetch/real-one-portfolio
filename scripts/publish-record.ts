/**
 * Publishes one record written by hand — an article too long, or too exactly
 * worded, to go through the Telegram pipeline, which drafts from the author's
 * note rather than printing it.
 *
 * The record is appended the way the Worker appends one (publishRecord in
 * worker/src/publishing/publish.ts): into a copy of the latest chunk under a new
 * id if that chunk has room, or into a new chunk if it is full, and the
 * manifest is written last. A chunk nothing points at is invisible, so a
 * failure between the two writes leaves the site exactly as it was.
 *
 * The id and publishedAt are stamped here. Pass `--id` when the record's media
 * was uploaded first — under media/activity-<id>, which the record's URLs
 * already name — so the two agree.
 *
 * R2 has no locking and wrangler cannot write conditionally, so this assumes
 * nothing else publishes while it runs: the same assumption unpublish-record.ts
 * makes. It checks the manifest has not moved just before writing it.
 *
 * Usage:
 *   set -a; . ./infrastructure/.env; . ./worker/.env; set +a
 *   npx tsx scripts/publish-record.ts <record.json> [--id <record-id>]
 *
 * Exit code 0 = published, 1 = refused or failed.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  CHUNK_CACHE_CONTROL,
  MANIFEST_CACHE_CONTROL,
  MANIFEST_KEY,
  type Manifest,
  type PublicRecord,
  isRecordId,
  manifestWith,
  problemsWith,
  put,
  randomId,
  readJson,
  rolls,
} from "./content-bucket.js";

const args = process.argv.slice(2);
const idFlag = args.indexOf("--id");
const givenId = idFlag >= 0 ? args[idFlag + 1] : undefined;
const file = args.find((arg, index) => !arg.startsWith("--") && index !== idFlag + 1);

const bucket = process.env.CONTENT_BUCKET;
const base = process.env.CONTENT_BASE_URL?.replace(/\/$/, "");
const apiToken = process.env.CLOUDFLARE_API_TOKEN;

const missing = Object.entries({ CONTENT_BUCKET: bucket, CONTENT_BASE_URL: base, CLOUDFLARE_API_TOKEN: apiToken })
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (!file || missing.length > 0 || (idFlag >= 0 && !(givenId && isRecordId(givenId)))) {
  console.error("Cannot publish the record.");
  if (!file) console.error("  no record file given");
  if (idFlag >= 0 && !(givenId && isRecordId(givenId))) console.error("  --id must be 16 Crockford base32 characters");
  for (const name of missing) console.error(`  ${name} is not set`);
  console.error("\nUsage: npx tsx scripts/publish-record.ts <record.json> [--id <record-id>]");
  console.error("CONTENT_BUCKET and CONTENT_BASE_URL live in worker/.env,");
  console.error("CLOUDFLARE_API_TOKEN in infrastructure/.env.");
  process.exit(1);
}

const written = JSON.parse(readFileSync(file, "utf8")) as unknown;
const problems = problemsWith(written);
if (problems.length > 0) {
  console.error(`${file} is not a record the site can show:`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

const now = new Date();
const record: PublicRecord = {
  id: givenId ?? randomId(16),
  ...(written as { title: string }),
  publishedAt: now.toISOString(),
};

const manifest = await readJson<Manifest>(base!, MANIFEST_KEY);
for (const entry of manifest.records) {
  const records = await readJson<PublicRecord[]>(base!, `content/records-${entry.id}.json`);
  if (records.some((existing) => existing.id === record.id)) {
    console.error(`A record with id ${record.id} is already published, in chunk ${entry.id}.`);
    process.exit(1);
  }
}

const rolled = rolls(manifest);
const before = rolled ? [] : await readJson<PublicRecord[]>(base!, `content/records-${manifest.latest}.json`);
const chunk = [...before, record];
const body = JSON.stringify(chunk, null, 2);
const chunkId = randomId(12);

put(bucket!, `content/records-${chunkId}.json`, body, CHUNK_CACHE_CONTROL);
console.log(`  chunk ${chunkId} written with ${chunk.length} record(s)${rolled ? "" : `, replacing ${manifest.latest}`}`);

const current = await readJson<Manifest>(base!, MANIFEST_KEY);
if (current.updatedAt !== manifest.updatedAt) {
  console.error("The manifest changed while this ran; nothing points at the new chunk. Run it again.");
  process.exit(1);
}

const sha256 = createHash("sha256").update(body).digest("hex");
const updated = manifestWith(manifest, { id: chunkId, sha256, count: chunk.length }, rolled, now);
put(bucket!, MANIFEST_KEY, `${JSON.stringify(updated, null, 2)}\n`, MANIFEST_CACHE_CONTROL);

console.log(`Published ${record.id}: "${record.title}". ${updated.totalRecords} record(s) in all.`);
