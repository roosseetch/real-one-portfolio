import { describe, expect, it } from "vitest";

import { headerFor, truncatedBody } from "../test-support/bytes";
import { classifyFile, resendsAsPhoto, sniff, SNIFF_BYTES } from "./formats";

describe("what a file claims to be", () => {
  it("takes a webp by its mime type", () => {
    expect(classifyFile({ mime: "image/webp", name: "photo.webp" })).toEqual({
      status: "accept",
      kind: "image",
    });
  });

  // The report that started this: Telegram sent a picture and said nothing
  // about what it was, and the old check read that silence as "not an image".
  it("takes a webp Telegram gave no mime type for, from its file name", () => {
    expect(classifyFile({ mime: null, name: "Image_20260806_114203.webp" })).toEqual({
      status: "accept",
      kind: "image",
    });
  });

  it("takes a file Telegram could only call application/octet-stream", () => {
    expect(classifyFile({ mime: "application/octet-stream", name: "holiday.jpg" })).toEqual({
      status: "accept",
      kind: "image",
    });
  });

  it("files a video document as a video, not an image", () => {
    expect(classifyFile({ mime: "video/mp4", name: "clip.mp4" })).toEqual({
      status: "accept",
      kind: "video",
    });
  });

  it("refuses a file whose type and name both say it is not media", () => {
    expect(classifyFile({ mime: "application/pdf", name: "invoice.pdf" })).toEqual({ status: "unknown" });
  });

  it("refuses a file with nothing to go on at all", () => {
    expect(classifyFile({ mime: null, name: null })).toEqual({ status: "unknown" });
  });

  it("names HEIC rather than calling it not an image, since Pillow has no plugin for it", () => {
    expect(classifyFile({ mime: "image/heic", name: "IMG_0421.HEIC" })).toEqual({
      status: "unopenable",
      kind: "image",
      label: "HEIC",
    });
  });

  it("names SVG, which has no pixels to resize", () => {
    expect(classifyFile({ mime: "image/svg+xml", name: "logo.svg" })).toMatchObject({
      status: "unopenable",
      label: "SVG",
    });
  });

  // Believing a declared type either way is the point: retrying a refused
  // format against its extension would only find the same answer, or a wrong one.
  it("refuses a declared HEIC without falling back to a friendlier extension", () => {
    expect(classifyFile({ mime: "image/heic", name: "IMG_0421.jpg" })).toMatchObject({
      status: "unopenable",
      label: "HEIC",
    });
  });

  it("believes a declared PDF over a file name saying otherwise", () => {
    // The mirror of the bug: falling back to the name whenever the type is not
    // in the table would let anything through under a .webp suffix.
    expect(classifyFile({ mime: "application/pdf", name: "invoice.webp" })).toEqual({ status: "unknown" });
  });

  it("names an image type it has never heard of, rather than denying it is an image", () => {
    expect(classifyFile({ mime: "image/jxl", name: "photo.jxl" })).toEqual({
      status: "unopenable",
      kind: "image",
      label: "JXL",
    });
  });

  it("ignores the case of the extension, so .JPEG is still a JPEG", () => {
    expect(classifyFile({ mime: null, name: "HOLIDAY.JPEG" })).toMatchObject({ status: "accept" });
  });

  it("reads only the last dot segment, so report.pdf.exe is not a pdf", () => {
    expect(classifyFile({ mime: null, name: "report.pdf.exe" })).toEqual({ status: "unknown" });
  });
});

// Not a property of the file so much as of what Telegram will do with it: a
// .webp file reference is sticker-class to them, and a sticker takes no caption.
describe("what Telegram will re-send as a photo", () => {
  it("does not offer a webp, which sendPhoto refuses every time", () => {
    expect(resendsAsPhoto("originals/act1/media0.webp")).toBe(false);
  });

  it("offers a jpeg, which is the shape the preview wants", () => {
    expect(resendsAsPhoto("originals/act1/media0.jpg")).toBe(true);
  });

  it("ignores the case of the extension", () => {
    expect(resendsAsPhoto("originals/act1/MEDIA0.WEBP")).toBe(false);
  });

  // The rung below still catches a refusal, whereas guessing "no" would cost
  // every unusual key the caption-on-photo shape spec §7.2 asks for.
  it("offers a name it cannot place, rather than assuming the worst", () => {
    expect(resendsAsPhoto("originals/act1/media0")).toBe(true);
  });
});

describe("what the first bytes actually say", () => {
  it("recognises the still formats the sanitiser can open", () => {
    expect(sniff(headerFor("jpeg"))).toMatchObject({ kind: "image", label: "JPEG", open: true });
    expect(sniff(headerFor("png"))).toMatchObject({ kind: "image", label: "PNG", open: true });
    expect(sniff(headerFor("webp"))).toMatchObject({ kind: "image", label: "WebP", open: true });
    expect(sniff(headerFor("gif"))).toMatchObject({ kind: "image", label: "GIF", open: true });
    expect(sniff(headerFor("tiff"))).toMatchObject({ kind: "image", label: "TIFF", open: true });
    expect(sniff(headerFor("bmp"))).toMatchObject({ kind: "image", label: "BMP", open: true });
  });

  it("requires both RIFF and WEBP, so a wav file is not a picture", () => {
    expect(sniff(headerFor("wav"))).toBeNull();
  });

  it("recognises an mp4 by its ftyp box and a webm by its EBML header", () => {
    expect(sniff(headerFor("mp4"))).toMatchObject({ kind: "video", label: "MP4" });
    expect(sniff(headerFor("webm"))).toMatchObject({ kind: "video", label: "WebM" });
  });

  // All four are ISO-BMFF and all four carry ftyp. Stopping at the box and
  // calling them videos files an iPhone photo as a video, and a video draft
  // stalls in `processing` for good rather than merely being dropped.
  it("calls a HEIC a HEIC rather than an mp4, though both carry ftyp", () => {
    expect(sniff(headerFor("heic"))).toMatchObject({ kind: "image", label: "HEIC", open: false });
  });

  it("calls an AVIF an AVIF rather than an mp4", () => {
    expect(sniff(headerFor("avif"))).toMatchObject({ kind: "image", label: "AVIF", open: false });
  });

  it("keeps a QuickTime file a video, since qt is a brand like any other", () => {
    expect(sniff(headerFor("mov"))).toMatchObject({ kind: "video", label: "MOV" });
  });

  it("recognises a PDF and an archive well enough to name them in a refusal", () => {
    expect(sniff(headerFor("pdf"))).toMatchObject({ label: "PDF", open: false });
    expect(sniff(headerFor("zip"))).toMatchObject({ label: "archive", open: false });
  });

  // A .tgs animated sticker sent as a file is gzip, and naming it beats
  // telling the author their picture is not a picture.
  it("recognises the gzip a .tgs sticker arrives as", () => {
    expect(sniff(headerFor("gzip"))).toMatchObject({ label: "compressed file", open: false });
  });

  it("says nothing at all when there are too few bytes to look at", () => {
    expect(sniff(new Uint8Array(truncatedBody()))).toBeNull();
  });

  it("reads enough bytes for the longest signature it checks", () => {
    // The ISO-BMFF brand ends at 12 and the WebP marker at 12; anything less
    // and the ftyp brands collapse back into "some kind of mp4".
    expect(SNIFF_BYTES).toBeGreaterThanOrEqual(12);
  });
});
