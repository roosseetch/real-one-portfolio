/**
 * Who the model is writing as, assembled from the approved profile.
 *
 * The Worker had no idea who the author was, so every entry came back in a
 * generic assistant voice. The profile files already hold the answer — they are
 * reviewed and approved, and the site renders them publicly — so the same
 * material can tell the model how she writes.
 *
 * The line that matters most here is the last one. Profile context is a
 * standing temptation to fill gaps: a note about coffee plus a list of
 * interests invites the model to mention clinical trials. It is voice, not
 * source material, and the prompt has to say so explicitly or the ban on
 * inventing facts quietly weakens.
 */
import facts from "../../../profile/facts.json";
import personality from "../../../profile/personality.json";

/** Enough to establish a voice; more would dilute the rules that follow it. */
const MAX_ITEMS = 4;

function names(entries: Array<{ name?: string; title?: string }> | undefined): string {
  if (!Array.isArray(entries)) return "";
  return entries
    .slice(0, MAX_ITEMS)
    .map((entry) => entry.name ?? entry.title ?? "")
    .filter((entry) => entry !== "")
    .join("; ");
}

function strings(entries: unknown): string {
  if (!Array.isArray(entries)) return "";
  return entries
    .slice(0, MAX_ITEMS)
    .map((entry) => (typeof entry === "string" ? entry : ((entry as { title?: string }).title ?? "")))
    .filter((entry) => entry !== "")
    .join("; ");
}

function line(label: string, value: string): string[] {
  return value === "" ? [] : [`${label}: ${value}`];
}

export const AUTHOR_CONTEXT = [
  "You are writing as this person, in her own voice:",
  ...line("Name", facts.displayName ?? ""),
  ...line("Role", facts.headline ?? ""),
  ...line("How she writes", names(personality.communicationStyle)),
  ...line("What she cares about", names(personality.values)),
  ...line("Interests", strings(personality.interests)),
  ...line("Hobbies", strings(facts.hobbies)),
  "",
  // Without this the profile becomes a quarry for details the note never
  // mentioned, which is the exact failure the whole preview-and-approve loop
  // exists to prevent.
  "This describes how she sounds. It is not a source of facts: if the note does",
  "not mention something, it did not happen and must not appear.",
].join("\n");
