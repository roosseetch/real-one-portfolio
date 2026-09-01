/**
 * Puts the two typefaces the design needs into the public media bucket.
 *
 * A one-off. Fonts change when a family is re-cut, which is a version bump in
 * site/src/fonts.ts and a second run of this — not something a publication or a
 * deploy should be doing, which is why it is a script somebody runs and not a
 * step in a workflow.
 *
 * It reads the face table from site/src/fonts.ts rather than repeating it, so
 * the object names the site asks for and the object names that exist cannot
 * drift. Each file is fetched from the `fallback` URL already declared there —
 * the copy in the bucket is a copy of exactly the thing the fallback serves,
 * and this is what makes that true rather than hoped.
 *
 * Uploads through Cloudflare's own API with CLOUDFLARE_API_TOKEN, the way
 * scripts/upload-media.py does, so nothing has to be installed on the machine
 * running it. Objects are written with the immutable cache header the bucket's
 * ruleset respects: the version is in the filename, so a re-cut family is a new
 * name rather than a new body at an old one.
 *
 * Usage:
 *   set -a; . infrastructure/.env; set +a
 *   npx tsx scripts/upload-fonts.ts <media-bucket-name>
 *
 * The bucket name is an argument rather than a constant because it is a
 * deployment value, and no tracked file here names one (spec §1). Terraform
 * prints it: `terraform output media_bucket_name`.
 *
 * Exit code 0 = every face uploaded, 1 = anything went wrong.
 */
import { FONT_FACES } from "../site/src/fonts.js";

const API = "https://api.cloudflare.com/client/v4";

const token = process.env.CLOUDFLARE_API_TOKEN;
const bucket = process.argv[2];

if (!token) {
  console.error("CLOUDFLARE_API_TOKEN is not set. Source infrastructure/.env first.");
  process.exit(1);
}
if (!bucket) {
  console.error("Usage: npx tsx scripts/upload-fonts.ts <media-bucket-name>");
  process.exit(1);
}

const auth = { Authorization: `Bearer ${token}` };

async function accountId(): Promise<string> {
  const response = await fetch(`${API}/accounts`, { headers: auth });
  const body = (await response.json()) as { success: boolean; result?: { id: string }[] };
  if (!body.success || !body.result?.[0]) {
    console.error("Could not read the account from Cloudflare.");
    process.exit(1);
  }
  return body.result[0].id;
}

/** woff2 begins with the four bytes `wOF2`. A redirect to an error page does not. */
function isWoff2(bytes: Uint8Array): boolean {
  return bytes[0] === 0x77 && bytes[1] === 0x4f && bytes[2] === 0x46 && bytes[3] === 0x32;
}

const account = await accountId();

for (const face of FONT_FACES) {
  const source = await fetch(face.fallback, {
    // Google serves woff2 only to clients it believes support it, and decides
    // from the user agent. Node's default is not on that list, and the answer
    // to an unrecognised one is a TrueType file with the same URL.
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    },
  });
  if (!source.ok) {
    console.error(`Could not fetch ${face.fallback}: HTTP ${source.status}`);
    process.exit(1);
  }
  const bytes = new Uint8Array(await source.arrayBuffer());
  if (!isWoff2(bytes)) {
    console.error(`${face.fallback} did not return a woff2 file.`);
    process.exit(1);
  }

  const key = `fonts/${face.file}`;
  const upload = await fetch(
    `${API}/accounts/${account}/r2/buckets/${bucket}/objects/${encodeURIComponent(key)}`,
    {
      method: "PUT",
      headers: {
        ...auth,
        "Content-Type": "font/woff2",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
      body: bytes,
    },
  );
  if (!upload.ok) {
    console.error(`Upload failed for ${key}: HTTP ${upload.status} ${(await upload.text()).slice(0, 200)}`);
    process.exit(1);
  }

  console.log(`  ${key.padEnd(46)} ${(bytes.length / 1024).toFixed(1).padStart(6)} KiB  ${face.family} ${face.weight}`);
}

console.log(`\n${FONT_FACES.length} faces uploaded to ${bucket}/fonts/`);
console.log("Confirm they are reachable with: MEDIA_BASE_URL=… npm run fonts:check");
