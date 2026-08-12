import { describe, expect, it } from "vitest";

import { linkedInLink, renderFooter } from "./sections";

describe("linkedInLink", () => {
  const URL = "example-person";

  /**
   * The profile stores the handle and this builds the address. A URL in profile
   * content would be an absolute URL and a domain, which validate-profile.ts
   * refuses — a reusable repository's profile names no hosts.
   */
  it("builds the address from the handle the profile declares", () => {
    const link = linkedInLink(URL);

    expect(link?.tagName).toBe("A");
    expect(link?.getAttribute("href")).toBe("https://www.linkedin.com/in/example-person");
  });

  /** The only child is a decorative glyph, so the link needs a name of its own. */
  it("carries an accessible name, and hides the glyph from the reader", () => {
    const link = linkedInLink(URL) as HTMLAnchorElement;

    expect(link.getAttribute("aria-label")).toBe("LinkedIn");
    expect(link.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("opens away from the site without handing it the opener", () => {
    const link = linkedInLink(URL) as HTMLAnchorElement;

    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  it("draws the mark rather than fetching it, so no request leaves the page", () => {
    const link = linkedInLink(URL) as HTMLAnchorElement;
    const svg = link.querySelector("svg");

    expect(svg?.querySelector("path")?.getAttribute("d")).toMatch(/^M20\.45/);
    expect(link.querySelector("img")).toBeNull();
    // The stylesheet owns the shade, so the mark inherits it.
    expect(svg?.getAttribute("fill")).toBe("currentColor");
  });

  /** A deployment with no LinkedIn renders no LinkedIn, rather than a dead link. */
  it("renders nothing when the profile declares none", () => {
    expect(linkedInLink(undefined)).toBeNull();
    expect(linkedInLink("")).toBeNull();
  });

  /**
   * The schema already pins the character class, but the profile is fetched from
   * a bucket at build time rather than read out of the repository — so what
   * reaches here is not what a validator saw. A "handle" carrying a colon or a
   * slash is not a handle, it is an address of someone else's choosing.
   */
  it("refuses anything that is not a handle", () => {
    expect(linkedInLink("javascript:alert(1)")).toBeNull();
    expect(linkedInLink("https://www.linkedin.com/in/example-person")).toBeNull();
    expect(linkedInLink("../../elsewhere")).toBeNull();
    expect(linkedInLink("example person")).toBeNull();
    expect(linkedInLink("a".repeat(101))).toBeNull();
  });
});

describe("the footer", () => {
  it("shows the icon under the name, given a profile that has one", () => {
    const section = document.createElement("section");
    renderFooter(section);

    // The fixture profile carries a LinkedIn URL, which is what CI runs against.
    const link = section.querySelector("a.footer-social");
    expect(link?.getAttribute("aria-label")).toBe("LinkedIn");

    const order = [...section.children].map((child) => child.className);
    expect(order).toEqual(["footer-name", "footer-headline", "footer-links"]);
  });
});
