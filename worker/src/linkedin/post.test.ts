import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ComposedPost } from "./compose";
import { publishPost } from "./post";

const POST: ComposedPost = {
  commentary: "Morning run by the river\n\nhttps://site.example/activities/?v=morning-run",
  preview: "Morning run by the river\n\nhttps://site.example/activities/?v=morning-run",
  url: "https://site.example/activities/?v=morning-run",
  title: "Morning run by the river",
  description: "An easy 8 km before work.",
};

let calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }>;

function answer(status: number, headers: Record<string, string> = {}) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : {},
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(null, { status, headers });
  });
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("publishPost", () => {
  it("posts as the member, with the version the API requires", async () => {
    answer(201, { "x-restli-id": "urn:li:share:7123" });

    const result = await publishPost("tok", "urn:li:person:abc", POST);

    expect(result).toEqual({ status: "posted", url: "https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A7123/" });
    expect(calls[0].url).toBe("https://api.linkedin.com/rest/posts");
    expect(calls[0].headers.authorization).toBe("Bearer tok");
    expect(calls[0].headers["linkedin-version"]).toMatch(/^\d{6}$/);
    expect(calls[0].headers["x-restli-protocol-version"]).toBe("2.0.0");
    expect(calls[0].body.author).toBe("urn:li:person:abc");
    expect(calls[0].body.commentary).toBe(POST.commentary);
    expect(calls[0].body.lifecycleState).toBe("PUBLISHED");
    expect(calls[0].body.visibility).toBe("PUBLIC");
  });

  /**
   * /activities/?v=… is one static page serving one set of OG tags for every
   * activity, so a card LinkedIn crawled would name the feed rather than this
   * record.
   */
  it("describes the card itself rather than leaving it to LinkedIn's crawler", async () => {
    answer(201, { "x-restli-id": "urn:li:share:7123" });

    await publishPost("tok", "urn:li:person:abc", POST);

    expect(calls[0].body.content).toEqual({
      article: {
        source: "https://site.example/activities/?v=morning-run",
        title: "Morning run by the river",
        description: "An easy 8 km before work.",
      },
    });
  });

  it("omits an empty description rather than sending a blank one", async () => {
    answer(201, { "x-restli-id": "urn:li:share:7123" });

    await publishPost("tok", "urn:li:person:abc", { ...POST, description: "" });

    expect(calls[0].body.content).toEqual({
      article: { source: POST.url, title: POST.title },
    });
  });

  it("reports an expired or revoked grant as its own outcome", async () => {
    // It is the expected end of every sixty-day token, and the only outcome
    // that has an answer the author can act on.
    answer(401);
    expect(await publishPost("tok", "urn:li:person:abc", POST)).toEqual({ status: "unauthorized" });

    vi.restoreAllMocks();
    answer(403);
    expect(await publishPost("tok", "urn:li:person:abc", POST)).toEqual({ status: "unauthorized" });
  });

  it("fails on anything else", async () => {
    answer(422);
    expect(await publishPost("tok", "urn:li:person:abc", POST)).toEqual({ status: "failed" });
  });

  it("fails rather than throwing when LinkedIn cannot be reached", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    expect(await publishPost("tok", "urn:li:person:abc", POST)).toEqual({ status: "failed" });
  });

  /**
   * The post exists. Reporting a failure here is what would have it posted a
   * second time; the caller says so without a link instead.
   */
  it("still counts as posted when the id header is missing", async () => {
    answer(201);
    expect(await publishPost("tok", "urn:li:person:abc", POST)).toEqual({ status: "posted", url: "" });
  });
});
