/**
 * File headers, so a test can hand the intake something that survives being
 * sniffed.
 *
 * Every download is now checked against its first bytes, which means a mocked
 * body of `"binary-image-bytes"` is no longer a picture and every test that
 * files a photo would fail on it. Rather than scatter byte arrays through the
 * suites — and end up with a second, drifting copy of the signature table —
 * every test that needs a plausible file asks here.
 *
 * Not a test file itself — vitest only collects *.test.ts — but it lives under
 * src/ so the existing tsconfig typechecks it, and nothing in the entry graph
 * imports it, so wrangler never bundles it.
 */

export type SampleFormat =
  | "jpeg"
  | "png"
  | "webp"
  | "gif"
  | "tiff"
  | "bmp"
  | "mp4"
  | "mov"
  | "webm"
  | "heic"
  | "avif"
  | "pdf"
  | "gzip"
  | "zip"
  /** RIFF like a WebP, but not a WebP: the case a half-checked signature lets through. */
  | "wav";

const ascii = (text: string): number[] => [...text].map((character) => character.charCodeAt(0));

/** `....ftypBRND....` — the container HEIC, AVIF, MP4 and MOV all share. */
const isoBmff = (brand: string): number[] => [
  0x00,
  0x00,
  0x00,
  0x20,
  ...ascii("ftyp"),
  ...ascii(brand),
  0x00,
  0x00,
  0x00,
  0x00,
];

const HEADERS: Record<SampleFormat, number[]> = {
  jpeg: [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...ascii("JFIF"), 0x00, 0x01, 0x02, 0x00],
  png: [0x89, ...ascii("PNG"), 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, ...ascii("IHDR")],
  webp: [...ascii("RIFF"), 0x24, 0x00, 0x00, 0x00, ...ascii("WEBP"), ...ascii("VP8 ")],
  wav: [...ascii("RIFF"), 0x24, 0x00, 0x00, 0x00, ...ascii("WAVE"), ...ascii("fmt ")],
  gif: [...ascii("GIF89a"), 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00],
  tiff: [0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x0e, 0x00, 0x00, 0x01, 0x03, 0x00],
  bmp: [...ascii("BM"), 0x46, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x36, 0x00, 0x00, 0x00],
  mp4: isoBmff("isom"),
  mov: isoBmff("qt  "),
  heic: isoBmff("heic"),
  avif: isoBmff("avif"),
  webm: [0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x23, 0x42, 0x86],
  pdf: [...ascii("%PDF-1.7"), 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a],
  gzip: [0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00],
  zip: [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00],
};

/** Just the signature, for exercising `sniff` directly. */
export function headerFor(format: SampleFormat): Uint8Array {
  return Uint8Array.from(HEADERS[format]);
}

/**
 * A header padded out to something file-shaped, for a mocked download.
 *
 * The padding is zeroes: nothing reads past the signature, and a recognisable
 * filler would only invite a test to start asserting on it.
 */
export function bodyFor(format: SampleFormat, bytes = 64): ArrayBuffer {
  const header = HEADERS[format];
  const body = new Uint8Array(Math.max(bytes, header.length));
  body.set(header);
  return body.buffer;
}

/** Too short to carry any signature at all. */
export function truncatedBody(): ArrayBuffer {
  return Uint8Array.from([0xff, 0xd8, 0xff]).buffer;
}
