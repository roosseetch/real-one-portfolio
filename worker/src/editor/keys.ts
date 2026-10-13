/**
 * The keys that open the site's article editor.
 *
 * The editor is a page anyone can load, so the key in its link is the whole of
 * what makes it the author's. It is minted only from the bot, which only answers
 * the allowlisted author; it lives four hours; and it names what it may do:
 *
 *   crt_…  write one new article. The first publish binds it to the record it
 *          created, and every later publish with it amends that record, so a
 *          second press of Publish fixes a typo rather than posting a copy.
 *   upd_…  change one existing article, named at minting, and no other.
 *
 * Only the key's SHA-256 is stored, under drafts/ so the bucket's seven-day rule
 * sweeps it up. A copy of the bucket therefore holds nothing that opens the
 * editor, and lookup is by hash, so there is no comparison to time.
 */
import { sha256Hex } from "../crypto";
import { isValidId, randomId } from "../ids";

/** How long a link from the bot keeps working. */
export const KEY_TTL_MS = 4 * 60 * 60 * 1000;

/** 32 characters of a 32-letter alphabet: 160 bits, far past guessing. */
const SECRET_LENGTH = 32;

export type EditorKeyKind = "create" | "update";

const PREFIX: Record<EditorKeyKind, string> = { create: "crt_", update: "upd_" };

export interface EditorKey {
  kind: EditorKeyKind;
  /** Null on a create key until its first publish. */
  recordId: string | null;
  /**
   * The media folder pictures uploaded with this key go into, as
   * media/activity-<activityId>. On a create key it is also the id the new
   * record is published under, so the folder and the record agree.
   */
  activityId: string;
  /** Where the bot says "published". */
  chatId: number;
  createdAt: string;
  expiresAt: string;
}

export interface EditorKeysEnv {
  PRIVATE_BUCKET: R2Bucket;
}

function storedKey(hash: string): string {
  return `drafts/editor-keys/${hash}.json`;
}

const KEY_SHAPE = /^(crt|upd)_[0-9a-z]{32}$/;

/** Mints a key and stores its hash. Returns the key itself, which is never stored. */
export async function mintKey(
  env: EditorKeysEnv,
  kind: EditorKeyKind,
  chatId: number,
  recordId: string | null,
  now: Date = new Date(),
): Promise<{ key: string; expiresAt: string }> {
  const key = `${PREFIX[kind]}${randomId(SECRET_LENGTH)}`;
  const stored: EditorKey = {
    kind,
    recordId: kind === "update" ? recordId : null,
    activityId: randomId(),
    chatId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + KEY_TTL_MS).toISOString(),
  };

  await env.PRIVATE_BUCKET.put(storedKey(await sha256Hex(key)), JSON.stringify(stored), {
    httpMetadata: { contentType: "application/json" },
  });

  return { key, expiresAt: stored.expiresAt };
}

export type KeyLookup =
  | { status: "valid"; key: EditorKey; hash: string }
  | { status: "expired" }
  | { status: "unknown" };

/** The key a request presents, read from `Authorization: Bearer …`. */
export function presentedKey(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/.exec(header);
  return match && KEY_SHAPE.test(match[1]) ? match[1] : null;
}

/**
 * What a presented key may do, if anything.
 *
 * The prefix is checked against what was minted: a stored create key presented
 * as `upd_…` is not the key that was handed out, whatever its secret half says.
 */
export async function lookupKey(
  env: EditorKeysEnv,
  presented: string | null,
  now: Date = new Date(),
): Promise<KeyLookup> {
  if (presented === null || !KEY_SHAPE.test(presented)) return { status: "unknown" };

  const hash = await sha256Hex(presented);
  const object = await env.PRIVATE_BUCKET.get(storedKey(hash));
  if (object === null) return { status: "unknown" };

  let key: EditorKey;
  try {
    key = (await object.json()) as EditorKey;
  } catch {
    return { status: "unknown" };
  }

  if (key?.kind !== "create" && key?.kind !== "update") return { status: "unknown" };
  if (!presented.startsWith(PREFIX[key.kind])) return { status: "unknown" };
  if (!isValidId(key.activityId)) return { status: "unknown" };
  if (key.kind === "update" && !(typeof key.recordId === "string" && isValidId(key.recordId))) {
    return { status: "unknown" };
  }
  if (typeof key.expiresAt !== "string" || Date.parse(key.expiresAt) <= now.getTime()) {
    return { status: "expired" };
  }

  return { status: "valid", key, hash };
}

/** Records the article a create key has just published, so the next publish amends it. */
export async function bindKey(env: EditorKeysEnv, hash: string, key: EditorKey, recordId: string): Promise<void> {
  await env.PRIVATE_BUCKET.put(storedKey(hash), JSON.stringify({ ...key, recordId }), {
    httpMetadata: { contentType: "application/json" },
  });
}
