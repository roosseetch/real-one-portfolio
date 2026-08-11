/**
 * The three CSV records the contact form keeps, and the only safe way to change
 * one.
 *
 * They live under `contact-records/` rather than `contact/` on purpose: the
 * bucket's lifecycle rule expires everything under `contact/` within days,
 * which is right for a message in flight and wrong for a record meant to be
 * kept. Nothing here expires, which is a deliberate choice with a cost — see
 * the note on messages.csv.
 *
 * Every change is read-modify-write against a whole file, so two requests
 * arriving together could each read the same file and write over the other's
 * row. R2's conditional writes are what stops that: the write carries the etag
 * the read saw, R2 refuses it if the object has moved on, and the caller tries
 * again with the newer file. This is the same mechanism the callback nonces and
 * the submission throttle use, in its other form.
 */
import { csvText, parseCsv } from "./csv";

/** Not `contact/`: that prefix is swept by the bucket's lifecycle rule. */
const PREFIX = "contact-records/";

export const CODES_KEY = `${PREFIX}codes.csv`;
export const VERIFIED_KEY = `${PREFIX}verified.csv`;
export const MESSAGES_KEY = `${PREFIX}messages.csv`;

/**
 * How many times a conditional write may lose the race before giving up.
 *
 * Three is not a guess about contention — there is almost none here — but about
 * how long a visitor should wait before being told to try again.
 */
const MAX_ATTEMPTS = 3;

interface Loaded {
  rows: string[][];
  /** Null when the file does not exist yet, which the write turns into "create only if still absent". */
  etag: string | null;
}

async function load(bucket: R2Bucket, key: string): Promise<Loaded> {
  const object = await bucket.get(key);
  if (object === null) return { rows: [], etag: null };

  return { rows: parseCsv(await object.text()), etag: object.etag };
}

/**
 * Reads the file, hands the rows to `mutate`, and writes back what it returns —
 * retrying from a fresh read if somebody else wrote first.
 *
 * `mutate` may be called more than once and must not do anything but compute
 * the new rows. Anything with a side effect belongs to the caller, after this
 * resolves.
 */
export async function updateCsv(
  bucket: R2Bucket,
  key: string,
  mutate: (rows: string[][]) => string[][],
): Promise<void> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { rows, etag } = await load(bucket, key);
    const next = mutate(rows);

    const written = await bucket.put(key, csvText(next), {
      // Absent means "only if it is still absent"; present means "only if it has
      // not changed since the read above".
      onlyIf: etag === null ? { etagDoesNotMatch: "*" } : { etagMatches: etag },
      httpMetadata: { contentType: "text/csv" },
    });

    if (written !== null) return;
  }

  throw new Error(`Could not write ${key} without overwriting a concurrent change`);
}

export async function readCsv(bucket: R2Bucket, key: string): Promise<string[][]> {
  return (await load(bucket, key)).rows;
}

/** Appends one row, keeping whatever else arrived in the meantime. */
export async function appendRow(bucket: R2Bucket, key: string, fields: readonly string[]): Promise<void> {
  await updateCsv(bucket, key, (rows) => [...rows, [...fields]]);
}
