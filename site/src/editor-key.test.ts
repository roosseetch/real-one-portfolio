import { beforeEach, describe, expect, it } from "vitest";

import { forgetKey, takeKey } from "./editor-key";

const KEY = `crt_${"a".repeat(32)}`;

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, "", "/admin/");
});

describe("takeKey", () => {
  it("takes the key off the address and keeps it for the tab", () => {
    window.history.replaceState(null, "", `/admin/?key=${KEY}#top`);

    expect(takeKey()).toBe(KEY);
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("#top");
    expect(window.location.href).not.toContain(KEY);

    // A reload finds it again without the address carrying it.
    expect(takeKey()).toBe(KEY);
  });

  it("leaves other parameters where they were", () => {
    window.history.replaceState(null, "", `/admin/?key=${KEY}&x=1`);
    takeKey();
    expect(window.location.search).toBe("?x=1");
  });

  it("strips a malformed key too, and does not keep it", () => {
    window.history.replaceState(null, "", "/admin/?key=nonsense");
    expect(takeKey()).toBeNull();
    expect(window.location.search).toBe("");
    expect(takeKey()).toBeNull();
  });

  it("forgets a key that turned out to be dead", () => {
    window.history.replaceState(null, "", `/admin/?key=${KEY}`);
    takeKey();
    forgetKey();
    expect(takeKey()).toBeNull();
  });
});
