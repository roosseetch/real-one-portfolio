import { describe, expect, it } from "vitest";

import type { PublicRecord } from "../content/records";
import {
  applyField,
  describeField,
  EDITABLE_FIELDS,
  fieldCode,
  fieldFromCode,
  isClearable,
  parseFieldValue,
} from "./edit-fields";

function record(overrides: Partial<PublicRecord> = {}): PublicRecord {
  return {
    id: "aaaaaaaaaaaaaaaa",
    title: "A morning run",
    summary: "A short run before work.",
    body: "Eight kilometres before work.",
    eventDate: "2026-08-10",
    publishedAt: "2026-08-10T09:00:00.000Z",
    tags: ["Running", "Morning"],
    media: [],
    ...overrides,
  };
}

describe("parseFieldValue", () => {
  it("takes the author's words exactly as typed", () => {
    expect(parseFieldValue("body", "  Eight kilometres, in the rain.  ")).toEqual({
      status: "ok",
      value: "Eight kilometres, in the rain.",
    });
  });

  /** A heading is one line, and a pasted newline would render as a space anyway. */
  it("flattens a title onto one line rather than refusing it", () => {
    expect(parseFieldValue("title", "A morning\n\n  run")).toEqual({
      status: "ok",
      value: "A morning run",
    });
  });

  it("refuses an empty value, and says which button empties a field", () => {
    const title = parseFieldValue("title", "   ");
    const body = parseFieldValue("body", "");

    expect(title.status).toBe("rejected");
    expect(title.status === "rejected" && title.reason).toContain("cannot be empty");
    expect(body.status === "rejected" && body.reason).toContain('"Clear it"');
  });

  /** Nothing is silently truncated: a title cut to fit is a title nobody wrote. */
  it("refuses an overlong value with its length and the limit", () => {
    const result = parseFieldValue("title", "x".repeat(121));

    expect(result.status).toBe("rejected");
    expect(result.status === "rejected" && result.reason).toContain("121 characters");
    expect(result.status === "rejected" && result.reason).toContain("120");
  });

  it("accepts a value at exactly the limit", () => {
    expect(parseFieldValue("title", "x".repeat(120)).status).toBe("ok");
    expect(parseFieldValue("body", "x".repeat(4000)).status).toBe("ok");
    expect(parseFieldValue("summary", "x".repeat(301)).status).toBe("rejected");
  });

  describe("a date", () => {
    it("takes a calendar date", () => {
      expect(parseFieldValue("eventDate", "2026-08-12")).toEqual({ status: "ok", value: "2026-08-12" });
    });

    it("refuses anything that is not one, and says the shape it wants", () => {
      const result = parseFieldValue("eventDate", "12 August");

      expect(result.status).toBe("rejected");
      expect(result.status === "rejected" && result.reason).toContain("YYYY-MM-DD");
    });

    /**
     * The model's schema only ever pattern-matches this. A human typing by hand
     * gets the stricter check, because a date the site prints should be one.
     */
    it("refuses a day that does not exist", () => {
      expect(parseFieldValue("eventDate", "2026-02-31").status).toBe("rejected");
      expect(parseFieldValue("eventDate", "2026-13-01").status).toBe("rejected");
      // A leap day that does exist.
      expect(parseFieldValue("eventDate", "2028-02-29").status).toBe("ok");
    });
  });

  describe("tags", () => {
    it("splits on commas and on lines", () => {
      expect(parseFieldValue("tags", "Running, Morning\nRain")).toEqual({
        status: "ok",
        value: ["Running", "Morning", "Rain"],
      });
    });

    it("drops a repeat whatever its capitals", () => {
      expect(parseFieldValue("tags", "Running, running, RUNNING")).toEqual({
        status: "ok",
        value: ["Running"],
      });
    });

    it("refuses more than the record can hold", () => {
      const result = parseFieldValue("tags", "a,b,c,d,e,f,g,h,i");

      expect(result.status).toBe("rejected");
      expect(result.status === "rejected" && result.reason).toContain("9 tags");
    });

    it("refuses a tag longer than a tag can be", () => {
      expect(parseFieldValue("tags", `Running, ${"x".repeat(41)}`).status).toBe("rejected");
    });

    it("refuses a list with nothing in it", () => {
      expect(parseFieldValue("tags", " , , ").status).toBe("rejected");
    });
  });
});

describe("applyField", () => {
  it("replaces one field and leaves the rest of the record alone", () => {
    const before = record();
    const after = applyField(before, "body", "Eight kilometres, in the rain.");

    expect(after.body).toBe("Eight kilometres, in the rain.");
    expect(after.title).toBe(before.title);
    expect(after.summary).toBe(before.summary);
    expect(after.tags).toEqual(before.tags);
    expect(after.publishedAt).toBe(before.publishedAt);
  });

  /** Identity is what amendRecord reads as "nothing to do", so a resend rewrites nothing. */
  it("hands back the very same object when the value already stands", () => {
    const before = record();

    expect(applyField(before, "title", "A morning run")).toBe(before);
    expect(applyField(before, "eventDate", "2026-08-10")).toBe(before);
    expect(applyField(before, "tags", ["Running", "Morning"])).toBe(before);
  });

  it("notices a tag list that differs only in order", () => {
    const before = record();
    expect(applyField(before, "tags", ["Morning", "Running"])).not.toBe(before);
  });

  it("empties a field that null is allowed to empty", () => {
    expect(applyField(record(), "summary", null).summary).toBeNull();
    expect(applyField(record(), "eventDate", null).eventDate).toBeNull();
    expect(applyField(record(), "tags", []).tags).toEqual([]);
  });

  /** The site has nothing to head the page with, so the title is never cleared. */
  it("refuses to empty the title even if asked", () => {
    const before = record();
    expect(applyField(before, "title", null)).toBe(before);
    expect(isClearable("title")).toBe(false);
  });

  it("treats a record with no tags at all as having none", () => {
    const before = { ...record(), tags: undefined } as unknown as PublicRecord;
    expect(applyField(before, "tags", [])).toBe(before);
  });
});

describe("describeField", () => {
  it("reads a field back as a line", () => {
    expect(describeField(record(), "title")).toBe("A morning run");
    expect(describeField(record(), "tags")).toBe("Running, Morning");
  });

  it("says an empty field is empty rather than printing nothing", () => {
    expect(describeField(record({ summary: null }), "summary")).toBe("—");
    expect(describeField(record({ tags: [] }), "tags")).toBe("—");
    expect(describeField(record({ body: "   " }), "body")).toBe("—");
  });
});

describe("the callback codes", () => {
  it("round-trip every field", () => {
    for (const field of EDITABLE_FIELDS) {
      expect(fieldFromCode(fieldCode(field))).toBe(field);
    }
  });

  it("are one character each, so callback_data stays inside its budget", () => {
    for (const field of EDITABLE_FIELDS) expect(fieldCode(field)).toHaveLength(1);
  });

  it("name nothing for a code that is not one of them", () => {
    expect(fieldFromCode("z")).toBeNull();
    expect(fieldFromCode("")).toBeNull();
  });
});
