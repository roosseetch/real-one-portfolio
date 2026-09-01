import { describe, expect, it } from "vitest";

import { facts } from "./profile";
import { renderExperience } from "./sections";

/**
 * Read against the profile rather than against fixed strings: CI runs this with
 * a fixture profile and a developer runs it with a real one, and what is being
 * asserted is how two lists become one chronology — not whose chronology.
 */
function timeline(): HTMLElement {
  const section = document.createElement("section");
  renderExperience(section);
  return section;
}

function entries(): HTMLElement[] {
  return [...timeline().querySelectorAll<HTMLElement>(".timeline-entry")];
}

describe("the experience timeline", () => {
  it("carries every role and every qualification, and nothing else", () => {
    expect(entries()).toHaveLength(facts.experience.length + facts.education.length);
  });

  /**
   * The whole reason the two lists are merged. A role begun the year a doctorate
   * finished says something that two lists, each sorted on its own, cannot.
   */
  it("runs newest first, with the two lists interleaved", () => {
    const years = entries().map((entry) =>
      Number(entry.querySelector(".timeline-when")?.textContent?.match(/\d{4}/)?.[0]),
    );

    expect(years).toEqual([...years].sort((a, b) => b - a));

    // And interleaved by the exact rule that makes the merge work: work carries
    // `start` as YYYY-MM, study carries `year` alone, and both begin with the
    // same four digits, so one string comparison orders them without either
    // being padded into a date it does not have.
    const kinds = entries().map((entry) => (entry.classList.contains("is-work") ? "w" : "s"));
    const expected = [
      ...facts.experience.map((job) => ({ kind: "w", key: job.start ?? "" })),
      ...facts.education.map((award) => ({ kind: "s", key: award.year ?? "" })),
    ]
      .sort((a, b) => b.key.localeCompare(a.key))
      .map((entry) => entry.kind);

    expect(kinds).toEqual(expected);
  });

  it("puts work on one track and study on the other", () => {
    const work = entries().filter((entry) => entry.classList.contains("is-work"));
    const study = entries().filter((entry) => entry.classList.contains("is-study"));

    expect(work).toHaveLength(facts.experience.length);
    expect(study).toHaveLength(facts.education.length);
  });

  /**
   * The artboards date qualifications to the month — "December 2018", "April
   * 2013" — and the profile records the year alone. A month that is not in the
   * data is not a month to invent.
   */
  it("dates a qualification to the bare year the profile records", () => {
    const dates = entries()
      .filter((entry) => entry.classList.contains("is-study"))
      .map((entry) => entry.querySelector(".timeline-when")?.textContent);

    for (const date of dates) {
      expect(date).toMatch(/^Education\. \d{4}$/);
    }
  });

  /**
   * Which of the two lists an entry came from is said by the side of the spine
   * it sits on and the shape of its marker, and neither of those reaches a
   * screen reader. So each entry says it in words as well, set where only a
   * reader who cannot see the shape will meet it.
   */
  it("names the kind in text, since the shape alone does not reach a reader", () => {
    for (const entry of entries()) {
      const hidden = entry.querySelector(".visually-hidden")?.textContent;
      expect(hidden === "Work. " || hidden === "Education. ").toBe(true);
    }
  });

  it("keeps the summary and highlights the profile approved", () => {
    const withHighlights = facts.experience.filter(
      (job) => "highlights" in job && job.highlights?.length,
    ).length;

    expect(timeline().querySelectorAll(".timeline-highlights")).toHaveLength(withHighlights);
    expect(timeline().querySelectorAll(".timeline-summary").length).toBe(
      facts.experience.filter((job) => job.summary).length,
    );
  });
});
