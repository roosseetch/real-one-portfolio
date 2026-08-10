/**
 * Handing work to GitHub Actions (spec §10.2, §12).
 *
 * Two jobs go out this way, for the same reason: the Worker cannot do either
 * itself. Stripping EXIF and re-encoding needs exiftool and an image library,
 * and it has to happen somewhere ephemeral so a raw original never lands
 * anywhere durable; checking a stranger's message needs a model that is not
 * this Worker's own. Actions gets a runner that is destroyed afterwards.
 *
 * What crosses the boundary is deliberately almost nothing — an id and a job
 * token. No URLs, no bucket names, no chat id, no text. Workflow inputs are
 * visible in the Actions UI and in every log line that echoes them, so anything
 * put here is effectively published.
 */
import { randomId } from "../ids";

const API_BASE = "https://api.github.com";

/** Long enough that guessing one is hopeless; it is the only thing proving a callback belongs to this job. */
const JOB_TOKEN_LENGTH = 32;

export interface DispatchEnv {
  GITHUB_REPOSITORY: string;
  MEDIA_WORKFLOW_FILE: string;
  GITHUB_DISPATCH_TOKEN: string;
}

export interface ContactDispatchEnv {
  GITHUB_REPOSITORY: string;
  CONTACT_WORKFLOW_FILE: string;
  GITHUB_DISPATCH_TOKEN: string;
}

export interface DispatchedJob {
  jobToken: string;
  dispatchedAt: string;
}

export function newJobToken(): string {
  return randomId(JOB_TOKEN_LENGTH);
}

/**
 * Triggers one workflow. Returns false when GitHub refuses, which every caller
 * turns into something a person is told rather than into a job that silently
 * never ran.
 *
 * `what` names the workflow in the log, because the status code alone does not
 * say which dispatch failed and the URL that would is the one thing not worth
 * logging.
 */
async function dispatchWorkflow(
  env: { GITHUB_REPOSITORY: string; GITHUB_DISPATCH_TOKEN: string },
  workflow: string,
  inputs: Record<string, string>,
  what: string,
  ref: string,
): Promise<boolean> {
  try {
    const response = await fetch(
      `${API_BASE}/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${workflow}/dispatches`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "portfolio-worker",
        },
        body: JSON.stringify({ ref, inputs }),
      },
    );

    // 204 on success. Status only in the log: the URL carries the repository
    // and the body carries the job token.
    if (response.status !== 204) {
      console.error(`GitHub refused the ${what} workflow dispatch (status ${response.status})`);
      return false;
    }

    return true;
  } catch {
    console.error(`Could not reach GitHub to dispatch the ${what} workflow`);
    return false;
  }
}

/**
 * Triggers the media workflow. Returns false when GitHub refuses, which leaves
 * the caller to tell the author rather than stranding the draft in `processing`
 * with nothing running.
 */
export function dispatchMediaProcessing(
  env: DispatchEnv,
  draftId: string,
  jobToken: string,
  ref: string = "main",
): Promise<boolean> {
  return dispatchWorkflow(
    env,
    env.MEDIA_WORKFLOW_FILE || "process-media.yml",
    { draftId, jobToken },
    "media",
    ref,
  );
}

/**
 * Triggers the workflow that reads a contact submission and decides whether it
 * is worth forwarding. False leaves the visitor told the message could not be
 * accepted, which is true: nothing will ever come back for it.
 */
export function dispatchContactCheck(
  env: ContactDispatchEnv,
  submissionId: string,
  jobToken: string,
  ref: string = "main",
): Promise<boolean> {
  return dispatchWorkflow(
    env,
    env.CONTACT_WORKFLOW_FILE || "validate-contact.yml",
    { submissionId, jobToken },
    "contact",
    ref,
  );
}
