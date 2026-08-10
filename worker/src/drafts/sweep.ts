/**
 * The scheduled sweep for drafts nothing is coming back for.
 *
 * Task 27 gave every *reported* failure a way out: the media workflow posts to
 * /callbacks/media-failed, the draft moves to `failed`, and the author gets
 * Retry and Cancel. That covers a run that fails or is cancelled, because such
 * a run still executes its reporting step.
 *
 * It does not cover a run that never reaches one. A runner that dies outright,
 * a dispatch GitHub answers 204 to and never schedules, or a reporting step
 * whose own request fails, all leave a draft in `processing` with no live
 * buttons and an author who was told the link would follow. Nothing is running,
 * nothing will report, and the only thing that ever clears it is the bucket's
 * seven-day rule deleting the draft out from under them.
 *
 * This is the thing that notices. It is the only part of the system that decides
 * a publication failed without being told so, which is why the threshold is
 * generous rather than tight: the cost of waiting another twenty minutes is a
 * slower message, and the cost of being wrong is telling someone their post
 * failed while it is still being published.
 */
import { failDraft, type FailureEnv } from "./failure";
import { draftKey, loadDraft } from "./store";

/**
 * How long a draft may sit in `processing` before it is presumed stranded.
 *
 * The media job takes one to two minutes. Half an hour is far past any honest
 * slowness — a queued runner, a cold Rust build, a retried upload — and short
 * enough that the author is not left wondering for an afternoon.
 */
export const STRANDED_AFTER_MS = 30 * 60 * 1000;

/** R2 lists in pages; this is its maximum, and far past one person's drafts. */
const PAGE_LIMIT = 1000;

/**
 * A stop, not a limit anyone should reach. It exists so a bucket that somehow
 * never stops paginating cannot hold the scheduled invocation open for ever.
 */
const MAX_PAGES = 20;

export interface SweepEnv extends FailureEnv {
  PRIVATE_BUCKET: R2Bucket;
}

export interface SweepResult {
  /** Drafts read, which is every `draft.json` under the prefix. */
  examined: number;
  /** Drafts moved to `failed` and reported to their author. */
  stranded: number;
}

/**
 * `drafts/{id}/draft.json` and nothing else.
 *
 * The prefix also holds `drafts/pending/{chatId}.json` and
 * `drafts/callback-nonces/{nonce}.json`, and there are far more nonces than
 * drafts. Matching on the shape of the key is what keeps this from reading every
 * one of them.
 */
function draftIdFrom(key: string): string | null {
  const prefix = "drafts/";
  const suffix = "/draft.json";
  if (!key.startsWith(prefix) || !key.endsWith(suffix)) return null;

  const id = key.slice(prefix.length, -suffix.length);
  // One segment. `drafts/pending/x/draft.json` is not a draft, and loadDraft
  // would refuse the id anyway — this says so here rather than by accident.
  return id === "" || id.includes("/") ? null : id;
}

/**
 * Reports every draft that has been in `processing` too long.
 *
 * Returns what it did rather than logging it, so the caller decides what a
 * quiet sweep is worth saying. Never throws: this runs on a timer with nobody
 * watching, and one unreadable draft must not stop the rest from being noticed.
 */
export async function sweepStrandedDrafts(
  env: SweepEnv,
  now: Date = new Date(),
): Promise<SweepResult> {
  const result: SweepResult = { examined: 0, stranded: 0 };
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    let listed: R2Objects;
    try {
      listed = await env.PRIVATE_BUCKET.list({ prefix: "drafts/", limit: PAGE_LIMIT, cursor });
    } catch {
      console.error("Could not list drafts to sweep");
      return result;
    }

    for (const object of listed.objects) {
      const draftId = draftIdFrom(object.key);
      if (draftId === null) continue;

      result.examined++;
      if (await sweepOne(env, draftId, now)) result.stranded++;
    }

    if (!listed.truncated) return result;
    cursor = listed.cursor;
  }

  console.error(`Stopped sweeping after ${MAX_PAGES} pages of drafts`);
  return result;
}

/** True when this draft was stranded and has now been reported. */
async function sweepOne(env: SweepEnv, draftId: string, now: Date): Promise<boolean> {
  let draft;
  try {
    draft = await loadDraft(env.PRIVATE_BUCKET, draftId);
  } catch {
    // One unreadable object is not a reason to stop noticing the others.
    console.error("Could not read a draft while sweeping");
    return false;
  }

  if (draft === null || draft.state !== "processing") return false;

  // Belt and braces against the race below: a draft whose record is already
  // live has nothing to fail, whatever its state field says.
  if (draft.published !== null) return false;

  // `job` is set at dispatch, and is the honest start of the wait. A draft in
  // `processing` without one was moved there by a retry that publishes inline,
  // so its own last write is the best answer.
  const startedAt = Date.parse(draft.job?.dispatchedAt ?? draft.updatedAt);
  if (!Number.isFinite(startedAt)) {
    // No usable timestamp, so its age cannot be judged. Left alone deliberately:
    // guessing here would mean failing a draft that might be seconds old.
    console.error("A processing draft carries no readable timestamp; not sweeping it");
    return false;
  }

  if (now.getTime() - startedAt < STRANDED_AFTER_MS) return false;

  // Says only that one was found, and where. The draft's text, its chat and its
  // media never reach a log; the key is content-independent by construction.
  console.error(`Sweeping a draft stranded in processing: ${draftKey(draftId)}`);

  // The race this cannot close: a callback that loaded the draft just before
  // this write can still publish afterwards, leaving the author a failure
  // message beside a published link. It cannot double-publish — every publish
  // path short-circuits on `published` — and at half an hour past dispatch a
  // callback landing mid-sweep is already pathological. Closing it properly
  // needs conditional writes on the draft itself, which every other writer
  // would have to learn too.
  return failDraft(env, draft, "abandoned");
}
