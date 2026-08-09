/**
 * What the publisher can actually open, and the three ways of finding out.
 *
 * This exists because the previous answer was one line — `mime.startsWith
 * ("image/")` — and it was wrong twice over. It refused a perfectly good WebP
 * whose `mime_type` Telegram had left off or reported as
 * `application/octet-stream`, and it accepted HEIC and SVG, which reach the
 * sanitiser and fail there, where nothing tells the author anything.
 *
 * So one table, three lookups: what the sender claimed (`classifyFile` by mime,
 * then by file name) and what the bytes say (`sniff`). Two separate tables is
 * how the same disagreement comes back — a HEIC refused by mime and accepted by
 * signature — so every format is one `FormatEntry` and the lookups only differ
 * in their key.
 *
 * The accepted set is not a matter of taste: it is exactly what `sanitizer/` can
 * open, which is the decoders enabled on the `image` crate in its Cargo.toml
 * (JPEG, PNG, WebP, TIFF, GIF, BMP) and ffmpeg for the videos. Adding a row here
 * without enabling the decoder there moves a silent Actions failure back into
 * existence.
 */

export type MediaKind = "image" | "video";

/** What Telegram said about a file, kept together so a refusal can quote it. */
export interface FileLabel {
  mime: string | null;
  name: string | null;
}

export interface FormatEntry {
  kind: MediaKind;
  /** What the author is told it is. "HEIC", not "image/heic". */
  label: string;
  /** False for a real picture the sanitiser has no decoder for. */
  open: boolean;
  /** What the private object is named when Telegram's file path carries no extension. */
  extension: string;
}

export type FormatVerdict =
  | { status: "accept"; kind: MediaKind }
  | { status: "unopenable"; kind: MediaKind; label: string }
  | { status: "unknown" };

const image = (label: string, extension: string, open = true): FormatEntry => ({
  kind: "image",
  label,
  open,
  extension,
});
const video = (label: string, extension: string, open = true): FormatEntry => ({
  kind: "video",
  label,
  open,
  extension,
});

const JPEG = image("JPEG", "jpg");
const PNG = image("PNG", "png");
const WEBP = image("WebP", "webp");
// The sanitiser decodes a GIF to its first frame and flattens it there. That is
// the intent: the site publishes stills.
const GIF = image("GIF", "gif");
const TIFF = image("TIFF", "tif");
const BMP = image("BMP", "bmp");

/**
 * Real pictures with no decoder behind them.
 *
 * The sanitiser writes AVIF but does not read one: `image` decodes AVIF only
 * with its `avif-native` feature, which pulls in dav1d, and HEIC needs a decoder
 * no Rust crate ships cleanly. SVG needs a rasteriser. None of the three is
 * enabled in `sanitizer/Cargo.toml`, so all three are refused here rather than
 * accepted and failed in Actions where nothing tells the author anything. Enable
 * the decoder there first, prove it, then flip `open`.
 */
const HEIC = image("HEIC", "heic", false);
const AVIF = image("AVIF", "avif", false);
const SVG = image("SVG", "svg", false);

const MP4 = video("MP4", "mp4");
const MOV = video("MOV", "mov");
const WEBM = video("WebM", "webm");

/** Named only so a refusal can say what it found, never to accept one. */
const PDF: FormatEntry = { kind: "image", label: "PDF", open: false, extension: "pdf" };
const ZIP: FormatEntry = { kind: "image", label: "archive", open: false, extension: "zip" };
/** What a .tgs animated sticker looks like when it arrives as a file. */
const GZIP: FormatEntry = { kind: "image", label: "compressed file", open: false, extension: "gz" };

/**
 * `image/jpg` and the two BMP spellings are not the registered names, but
 * clients emit them and a false refusal costs more than a redundant row.
 */
const BY_MIME = new Map<string, FormatEntry>([
  ["image/jpeg", JPEG],
  ["image/jpg", JPEG],
  ["image/pjpeg", JPEG],
  ["image/png", PNG],
  ["image/webp", WEBP],
  ["image/gif", GIF],
  ["image/tiff", TIFF],
  ["image/bmp", BMP],
  ["image/x-ms-bmp", BMP],
  ["image/x-bmp", BMP],
  ["image/heic", HEIC],
  ["image/heif", HEIC],
  ["image/heic-sequence", HEIC],
  ["image/heif-sequence", HEIC],
  ["image/avif", AVIF],
  ["image/svg+xml", SVG],
  ["video/mp4", MP4],
  ["video/quicktime", MOV],
  ["video/x-m4v", MP4],
  ["video/webm", WEBM],
]);

const BY_EXTENSION = new Map<string, FormatEntry>([
  ["jpg", JPEG],
  ["jpeg", JPEG],
  ["jpe", JPEG],
  ["png", PNG],
  ["webp", WEBP],
  ["gif", GIF],
  ["tif", TIFF],
  ["tiff", TIFF],
  ["bmp", BMP],
  ["heic", HEIC],
  ["heif", HEIC],
  ["avif", AVIF],
  ["svg", SVG],
  ["mp4", MP4],
  ["m4v", MP4],
  ["mov", MOV],
  ["webm", WEBM],
]);

/**
 * A mime type that says only "some bytes".
 *
 * This is the value that started all of this: a client that cannot name the
 * type sends one of these, and reading it as "not an image" threw the picture
 * away. Reaching one means fall through to the file name, not refuse.
 */
const GENERIC_MIME = new Set(["application/octet-stream", "binary/octet-stream", "application/binary"]);

function verdictFor(entry: FormatEntry): FormatVerdict {
  return entry.open
    ? { status: "accept", kind: entry.kind }
    : { status: "unopenable", kind: entry.kind, label: entry.label };
}

/** The last dot segment, lowercased, so `report.pdf.exe` is an `exe`. */
function extensionOf(name: string): string | null {
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(name);
  return match ? match[1].toLowerCase() : null;
}

/**
 * What the sender claims the file is: the mime type first, the file name second.
 *
 * The order matters and the fall-through condition more so. A declared type
 * that names a format is believed either way — a declared HEIC is refused as a
 * HEIC, not retried against its extension in the hope of a better answer. Only
 * a type that says nothing (absent, or one of the generic ones) hands the
 * question to the file name.
 *
 * A declared `image/*` or `video/*` that is in neither table is refused as
 * itself rather than as "not media at all", because telling an author their
 * picture is not a picture is how this looked from the outside the first time.
 */
export function classifyFile(file: FileLabel): FormatVerdict {
  const mime = file.mime?.trim().toLowerCase() ?? "";

  const declared = BY_MIME.get(mime);
  if (declared) return verdictFor(declared);

  // A type that says something, just not something in the table.
  if (mime !== "" && !GENERIC_MIME.has(mime)) {
    if (mime.startsWith("image/") || mime.startsWith("video/")) {
      const [type, subtype] = mime.split("/");
      return {
        status: "unopenable",
        kind: type === "video" ? "video" : "image",
        label: subtype.toUpperCase(),
      };
    }

    // `application/pdf`, `text/plain`: an answer, and the last one. Consulting
    // the file name here would mean a PDF renamed `photo.webp` is accepted,
    // which is the mislabelling problem this module exists to end, only the
    // other way round.
    return { status: "unknown" };
  }

  const named = file.name ? BY_EXTENSION.get(extensionOf(file.name) ?? "") : undefined;
  if (named) return verdictFor(named);

  return { status: "unknown" };
}

/**
 * Formats Telegram will not re-send through `sendPhoto`.
 *
 * Only WebP, and only because Telegram treats one as sticker-class: a sticker
 * carries no caption, so the call is refused rather than silently downgraded.
 * Everything else in the table above goes through as a photo.
 */
const STICKER_CLASS = new Set<FormatEntry>([WEBP]);

/**
 * Whether a stored original is worth offering to `sendPhoto` at all.
 *
 * The preview tries a photo first and an attachment second, and for a WebP the
 * first rung answered 400 every single time — a wasted round trip, and a
 * warning that reads like a fault on a request that then worked.
 *
 * Keyed off the stored object's name, which carries Telegram's own extension
 * or, where its path had none, the one the sniffed bytes gave it. A name this
 * cannot place is worth trying: the attachment rung still catches a refusal,
 * whereas guessing "no" would cost every unusual key the caption-on-photo shape
 * that spec §7.2 asks for.
 */
export function resendsAsPhoto(key: string): boolean {
  const entry = BY_EXTENSION.get(extensionOf(key) ?? "");
  return entry === undefined || !STICKER_CLASS.has(entry);
}

/** Enough for the WebP marker at 8 and the ISO-BMFF brand at 8, with headroom. */
export const SNIFF_BYTES = 16;

/** The shortest prefix any signature below needs. */
const MIN_SNIFF_BYTES = 12;

const textDecoder = new TextDecoder("ascii");

function ascii(head: Uint8Array, start: number, end: number): string {
  return textDecoder.decode(head.subarray(start, end));
}

function startsWithBytes(head: Uint8Array, bytes: number[]): boolean {
  return bytes.every((byte, index) => head[index] === byte);
}

/**
 * ISO-BMFF brands, which is where a naive signature table gets this wrong.
 *
 * HEIC, AVIF, MP4 and MOV are all the same container and all carry `ftyp` at
 * byte 4. Stopping there and calling every one of them a video files an iPhone
 * photo as a video, which sends it down the transcode path: ffmpeg would be
 * handed a still image, the poster frame would be the picture itself, and the
 * author would be shown a one-frame film of their own photograph. The brand at
 * bytes 8..12 is the only thing that separates them.
 */
const BRANDS = new Map<string, FormatEntry>([
  ["heic", HEIC],
  ["heix", HEIC],
  ["heim", HEIC],
  ["heis", HEIC],
  ["hevc", HEIC],
  ["hevx", HEIC],
  ["mif1", HEIC],
  ["msf1", HEIC],
  ["avif", AVIF],
  ["avis", AVIF],
  ["qt  ", MOV],
]);

/**
 * What the bytes say, which is the only account of a file that cannot be wrong
 * by accident.
 *
 * Returns null for anything unrecognised, including a file too short to have a
 * signature at all. Callers treat that as "not something to publish": guessing
 * from a header this does not know is what the mime check was already doing.
 */
export function sniff(head: Uint8Array): FormatEntry | null {
  if (head.length < MIN_SNIFF_BYTES) return null;

  if (startsWithBytes(head, [0xff, 0xd8, 0xff])) return JPEG;
  if (startsWithBytes(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return PNG;
  if (startsWithBytes(head, [0x1a, 0x45, 0xdf, 0xa3])) return WEBM;
  if (startsWithBytes(head, [0x25, 0x50, 0x44, 0x46])) return PDF;
  if (startsWithBytes(head, [0x50, 0x4b, 0x03, 0x04])) return ZIP;
  if (startsWithBytes(head, [0x1f, 0x8b])) return GZIP;
  if (startsWithBytes(head, [0x49, 0x49, 0x2a, 0x00])) return TIFF;
  if (startsWithBytes(head, [0x4d, 0x4d, 0x00, 0x2a])) return TIFF;

  const first6 = ascii(head, 0, 6);
  if (first6 === "GIF87a" || first6 === "GIF89a") return GIF;
  if (first6.startsWith("BM")) return BMP;

  // Both halves, or a .wav — which is also RIFF — passes as a picture.
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP") return WEBP;

  if (ascii(head, 4, 8) === "ftyp") {
    return BRANDS.get(ascii(head, 8, 12).toLowerCase()) ?? MP4;
  }

  return null;
}
