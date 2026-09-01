import { describe, expect, it } from "vitest";

import { facts } from "./profile";
import { renderHobbies } from "./sections";

function hobbies() {
  const section = document.createElement("section");
  renderHobbies(section);
  return {
    tabs: [...section.querySelectorAll<HTMLButtonElement>('[role="tab"]')],
    panels: [...section.querySelectorAll<HTMLElement>('[role="tabpanel"]')],
    rail: section.querySelector<HTMLElement>('[role="tablist"]')!,
  };
}

function press(rail: HTMLElement, key: string) {
  rail.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

describe("the hobby rail", () => {
  it("names every hobby and shows exactly one", () => {
    const { tabs, panels } = hobbies();

    expect(tabs.map((tab) => tab.textContent)).toEqual(facts.hobbies.map((hobby) => hobby.title));
    expect(panels.filter((panel) => !panel.hidden)).toHaveLength(1);
    expect(tabs.filter((tab) => tab.getAttribute("aria-selected") === "true")).toHaveLength(1);
  });

  it("ties each tab to the panel it opens, and back again", () => {
    const { tabs, panels } = hobbies();

    tabs.forEach((tab, index) => {
      expect(tab.getAttribute("aria-controls")).toBe(panels[index].id);
      expect(panels[index].getAttribute("aria-labelledby")).toBe(tab.id);
    });
  });

  /** One stop for the whole rail, so Tab moves past it rather than through it. */
  it("keeps one tab in the tab order and the rest out of it", () => {
    const { tabs } = hobbies();

    expect(tabs.filter((tab) => tab.tabIndex === 0)).toHaveLength(1);
    expect(tabs.filter((tab) => tab.tabIndex === -1)).toHaveLength(tabs.length - 1);
  });

  it("opens the hobby a tab names when it is clicked", () => {
    const { tabs, panels } = hobbies();
    const last = tabs.length - 1;

    tabs[last].click();

    expect(panels[last].hidden).toBe(false);
    expect(panels.filter((panel) => !panel.hidden)).toHaveLength(1);
    expect(tabs[last].getAttribute("aria-selected")).toBe("true");
  });

  /**
   * The ARIA tabs contract: arrows move between tabs and wrap at the ends.
   *
   * Written against the profile's own length rather than against index 1: CI
   * runs this with a fixture profile carrying a single hobby, where every one
   * of these moves lands back on the same tab — which is the wrap working, not
   * a case to skip.
   */
  it("moves with the arrow keys and wraps around", () => {
    const { tabs, rail } = hobbies();
    const last = tabs.length - 1;
    const selected = () => tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true");

    press(rail, "ArrowRight");
    expect(selected()).toBe(last === 0 ? 0 : 1);

    press(rail, "ArrowLeft");
    expect(selected()).toBe(0);

    // Backwards off the front, which is where it wraps.
    press(rail, "ArrowLeft");
    expect(selected()).toBe(last);

    press(rail, "ArrowRight");
    expect(selected()).toBe(0);
  });

  it("jumps to the ends with Home and End", () => {
    const { tabs, rail } = hobbies();

    press(rail, "End");
    expect(tabs[tabs.length - 1].getAttribute("aria-selected")).toBe("true");

    press(rail, "Home");
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
  });

  it("leaves a key it does not handle to the browser", () => {
    const { rail } = hobbies();
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });

    rail.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  /**
   * A headline is someone's own words about their own hobby. Where the profile
   * has none the title is the heading and there is no kicker above it, rather
   * than a line invented to fill the space the design leaves for one.
   */
  it("sets the kicker only where the profile gives a headline", () => {
    const { panels } = hobbies();

    panels.forEach((panel, index) => {
      const hobby = facts.hobbies[index] as { title: string; headline?: string | null };
      expect(panel.querySelectorAll("h3")).toHaveLength(1);
      if (hobby.headline) {
        expect(panel.querySelector(".hobby-kicker")?.textContent).toBe(hobby.title);
        expect(panel.querySelector("h3")?.textContent).toBe(hobby.headline);
      } else {
        expect(panel.querySelector(".hobby-kicker")).toBeNull();
        expect(panel.querySelector("h3")?.textContent).toBe(hobby.title);
      }
    });
  });
});
