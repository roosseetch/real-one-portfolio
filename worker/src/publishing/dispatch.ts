/**
 * Hands a media draft to GitHub Actions for sanitisation (spec §10.2, §12).
 *
 * The Worker cannot do this work itself: stripping EXIF and re-encoding needs
 * exiftool and an image library, and it has to happen somewhere ephemeral so a
 * raw original never lands anywhere durable. Actions gets a runner that is
 * destroyed afterwards.
 *
 * What crosses the boundary is deliberately almost nothing — a draft id and a
 * job token. No URLs, no bucket names, no chat id, no text. Workflow inputs are
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

export interface DispatchedJob {
  jobToken: string;
  dispatchedAt: string;
}

export function newJobToken(): string {
  return randomId(JOB_TOKEN_LENGTH);
}

/**
 * Triggers the media workflow. Returns false when GitHub refuses, which leaves
 * the caller to tell the author rather than stranding the draft in `processing`
 * with nothing running.
 */
export async function dispatchMediaProcessing(
  env: DispatchEnv,
  draftId: string,
  jobToken: string,
  ref: string = "main",
): Promise<boolean> {
  const workflow = env.MEDIA_WORKFLOW_FILE || "process-media.yml";

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
        body: JSON.stringify({ ref, inputs: { draftId, jobToken } }),
      },
    );

    // 204 on success. Status only in the log: the URL carries the repository
    // and the body carries the job token.
    if (response.status !== 204) {
      console.error(`GitHub refused the media workflow dispatch (status ${response.status})`);
      return false;
    }

    return true;
  } catch {
    console.error("Could not reach GitHub to dispatch the media workflow");
    return false;
  }
}
