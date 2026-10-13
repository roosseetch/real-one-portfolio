import "./styles.css";
import "./editor.css";
import type { Editor, JSONContent } from "@tiptap/core";

import { activityHref, el, renderRecord, type ActivityMedia, type ActivityRecord } from "./activity";
import { docFromRecord } from "./editor-doc";
import { forgetKey, takeKey } from "./editor-key";
import { createEditor, figureStates, updateFigures } from "./editor-tiptap";
import { ARTICLE_FONTS, FONT_SIZES, cleanDoc, docFigures, docKey, type RichDoc } from "./rich-doc";
import { applyDesignTokens } from "./shell";

/**
 * The article editor's page (routes.ts, id "editor"), at /admin/.
 *
 * Deliberately not built on main.ts: no navigation, no footer, and above all no
 * analytics. The page holds a key that can publish on the site and an article
 * nobody has seen yet, and neither belongs in an analytics event, a session
 * replay or a Referer header (vite.config.ts sets no-referrer on this page).
 *
 * Everything the page can do, it does through the Worker's /editor/ routes
 * with the key in an Authorization header. The page itself is static and
 * public; without a key it shows one sentence and nothing else.
 */

const WORKER = import.meta.env.VITE_WORKER_BASE_URL?.replace(/\/$/, "") || null;
const CONTENT_BASE = import.meta.env.VITE_CONTENT_BASE_URL?.replace(/\/$/, "");

/** How often a picture still being sanitised is asked after. The run takes a minute or two. */
const POLL_MS = 5000;

const ASK_THE_BOT = 'Ask the bot for a new one: press "🖋 Write on the site".';

interface Session {
  kind: "create" | "update";
  expiresAt: string;
  mediaFolder: string;
  record: ActivityRecord | null;
}

interface Draft {
  title: string;
  summary: string;
  eventDate: string;
  tags: string;
  doc: JSONContent;
  savedAt: string;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.problem ?? body.status ?? status));
  }
}

async function api(key: string, path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await fetch(`${WORKER}/editor/${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${key}` },
    // The key travels in the header; nothing about the page needs to go with it.
    referrerPolicy: "no-referrer",
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // An answer with no JSON is described by its status alone.
  }
  if (!response.ok) throw new ApiError(response.status, body);
  return body;
}

function button(label: string, title: string, onClick: () => void, className = "editor-button"): HTMLButtonElement {
  const element = el("button", className, label) as HTMLButtonElement;
  element.type = "button";
  element.title = title;
  element.setAttribute("aria-label", title);
  element.addEventListener("mousedown", (event) => event.preventDefault());
  element.addEventListener("click", onClick);
  return element;
}

function select(label: string, options: Array<[string, string]>, onChange: (value: string) => void): HTMLSelectElement {
  const element = document.createElement("select");
  element.className = "editor-select";
  element.setAttribute("aria-label", label);
  element.title = label;
  for (const [value, text] of options) element.append(Object.assign(document.createElement("option"), { value, textContent: text }));
  element.addEventListener("change", () => onChange(element.value));
  return element;
}

function field(label: string, control: HTMLInputElement | HTMLTextAreaElement, hint?: string): HTMLElement {
  const wrapper = el("label", "editor-field");
  wrapper.append(el("span", "editor-label label", label), control);
  if (hint) wrapper.append(el("span", "editor-hint", hint));
  return wrapper;
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function left(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min left` : `${minutes} min left`;
}

function draftSlot(session: Session): string {
  return `article-editor-draft:${session.record?.id ?? "new"}`;
}

function readDraft(slot: string): Draft | null {
  try {
    const raw = localStorage.getItem(slot);
    return raw ? (JSON.parse(raw) as Draft) : null;
  } catch {
    return null;
  }
}

function writeDraft(slot: string, draft: Draft | null): void {
  try {
    if (draft === null) localStorage.removeItem(slot);
    else localStorage.setItem(slot, JSON.stringify(draft));
  } catch {
    // An unsaved draft is a convenience; the article is saved by publishing it.
  }
}

/** The document an update opens with: the stored one for an editor article, a conversion for anything older. */
async function startingDoc(record: ActivityRecord): Promise<RichDoc> {
  if (record.bodyFormat === "rich" && record.doc && CONTENT_BASE) {
    const response = await fetch(`${CONTENT_BASE}/${docKey(record.id, record.doc)}`);
    if (!response.ok) throw new Error(`the article's text could not be loaded (${response.status})`);
    const cleaned = cleanDoc(await response.json(), { allowSrc: () => true });
    if (!cleaned.ok) throw new Error(cleaned.problem);
    return cleaned.doc;
  }
  return docFromRecord(record);
}

function stop(root: HTMLElement, message: string): void {
  root.replaceChildren(el("h1", undefined, "Article editor"), el("p", "editor-stop", message));
}

async function start(root: HTMLElement): Promise<void> {
  const key = takeKey();
  if (key === null) {
    stop(root, `This page opens from a link the bot sends. ${ASK_THE_BOT}`);
    return;
  }
  if (WORKER === null) {
    stop(root, "This build of the site has no Worker address configured, so it cannot publish.");
    return;
  }

  root.replaceChildren(el("p", "editor-loading", "Opening the editor…"));

  let session: Session;
  try {
    session = (await api(key, "session")) as unknown as Session;
  } catch (error) {
    const status = error instanceof ApiError ? error.body.status : null;
    if (status === "expired") {
      forgetKey();
      stop(root, `This link has expired. ${ASK_THE_BOT}`);
    } else if (status === "unknown") {
      forgetKey();
      stop(root, `This link is not valid. ${ASK_THE_BOT}`);
    } else if (status === "gone") {
      stop(root, "The article this link was for is no longer on the site.");
    } else {
      stop(root, "The editor could not be reached just now. Reload the page in a moment.");
    }
    return;
  }

  let initial: RichDoc;
  try {
    initial = session.record ? await startingDoc(session.record) : { type: "doc", content: [{ type: "paragraph" }] };
  } catch (error) {
    stop(root, `The article could not be opened: ${(error as Error).message}. Reload the page to try again.`);
    return;
  }

  mount(root, key, session, initial);
}

function mount(root: HTMLElement, key: string, session: Session, initial: RichDoc): void {
  const record = session.record;
  // A create key that has published is an update from then on: the Worker
  // amends the same record, and the page says so.
  let publishedId = record?.id ?? null;
  let publishedHref = record ? activityHref(record) : null;
  const slot = draftSlot(session);

  /* ------------------------------------------------------------ header */

  const heading = el("h1", undefined, record ? `Update "${record.title}"` : "Write an article");
  const expiry = el("p", "editor-expiry label");
  const status = el("p", "editor-status");
  status.setAttribute("role", "status");
  const say = (message: string, tone: "info" | "error" | "done" = "info") => {
    status.textContent = message;
    status.dataset.tone = tone;
  };

  /* ------------------------------------------------------------ fields */

  const title = Object.assign(document.createElement("input"), { type: "text", required: true, maxLength: 200 });
  const summary = Object.assign(document.createElement("textarea"), { rows: 2, maxLength: 1000 });
  const eventDate = Object.assign(document.createElement("input"), { type: "date" });
  const tags = Object.assign(document.createElement("input"), { type: "text" });

  title.value = record?.title ?? "";
  summary.value = record?.summary ?? "";
  eventDate.value = record?.eventDate ?? "";
  tags.value = (record?.tags ?? []).join(", ");

  const fields = el("div", "editor-fields");
  fields.append(
    field("Title", title),
    field("Summary", summary, "Optional. Shown under the title and in link previews."),
    field("Date", eventDate, "Optional. The day it happened."),
    field("Tags", tags, "Optional. Separated by commas."),
  );

  /* ------------------------------------------------------------ editor */

  const surface = el("div", "editor-surface");
  const preview = el("div", "editor-preview");
  preview.hidden = true;

  const restored = readDraft(slot);
  let saveTimer: number | undefined;
  const scheduleSave = () => {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      writeDraft(slot, {
        title: title.value,
        summary: summary.value,
        eventDate: eventDate.value,
        tags: tags.value,
        doc: editor.getJSON(),
        savedAt: new Date().toISOString(),
      });
    }, 800);
  };

  const editor: Editor = createEditor(surface, restored?.doc ?? (initial as JSONContent), () => {
    scheduleSave();
    refresh();
  });
  for (const control of [title, summary, eventDate, tags]) control.addEventListener("input", scheduleSave);

  if (restored) {
    title.value = restored.title;
    summary.value = restored.summary;
    eventDate.value = restored.eventDate;
    tags.value = restored.tags;
  }

  /* ------------------------------------------------------------ toolbar */

  const toolbar = el("div", "editor-toolbar");
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Formatting");

  const chain = () => editor.chain().focus();

  const blockType = select(
    "Paragraph style",
    [
      ["p", "Paragraph"],
      ["h2", "Section heading"],
      ["h3", "Subheading"],
      ["h4", "Minor heading"],
      ["quote", "Pull quote"],
    ],
    (value) => {
      const c = chain();
      if (editor.isActive("blockquote") && value !== "quote") c.lift("blockquote");
      if (value === "p") c.setParagraph().run();
      else if (value === "quote") c.setParagraph().setBlockquote().run();
      else c.setHeading({ level: Number(value.slice(1)) as 2 | 3 | 4 }).run();
    },
  );

  const fontPicker = select(
    "Font",
    [["", "Default font"], ...ARTICLE_FONTS.map((family): [string, string] => [family, family])],
    (value) => {
      if (value) chain().setMark("textStyle", { fontFamily: value }).run();
      else chain().setMark("textStyle", { fontFamily: null }).removeEmptyTextStyle().run();
    },
  );
  // Each name is shown in its own face, so the list is also the sample.
  for (const option of fontPicker.options) if (option.value) option.style.fontFamily = `"${option.value}"`;

  const sizePicker = select(
    "Text size",
    [
      ["", "Normal size"],
      [FONT_SIZES.small, "Small"],
      [FONT_SIZES.large, "Large"],
      [FONT_SIZES.larger, "Larger"],
    ],
    (value) => {
      if (value) chain().setMark("textStyle", { fontSize: value }).run();
      else chain().setMark("textStyle", { fontSize: null }).removeEmptyTextStyle().run();
    },
  );

  const toggles: Array<[HTMLButtonElement, () => boolean]> = [];
  const toggle = (label: string, title: string, run: () => void, active: () => boolean, className = "") => {
    const element = button(label, title, run, `editor-button ${className}`.trim());
    element.setAttribute("aria-pressed", "false");
    toggles.push([element, active]);
    return element;
  };

  const group = (...children: HTMLElement[]) => {
    const wrapper = el("div", "editor-group");
    wrapper.append(...children);
    return wrapper;
  };

  /* An inline bar under the toolbar for the two things that need typing: a link's address, and a picture's words. */
  const inspector = el("div", "editor-inspector");
  inspector.hidden = true;

  const openLinkInspector = () => {
    const current = (editor.getAttributes("link").href as string | undefined) ?? "";
    const input = Object.assign(document.createElement("input"), {
      type: "url",
      value: current,
      placeholder: "https://…",
    });
    input.setAttribute("aria-label", "Link address");
    const apply = () => {
      const href = input.value.trim();
      if (href === "") chain().extendMarkRange("link").unsetLink().run();
      else {
        let ok = false;
        try {
          const parsed = new URL(href);
          ok = ["https:", "http:", "mailto:"].includes(parsed.protocol);
        } catch {
          ok = false;
        }
        if (!ok) {
          say("A link has to start with https://, http:// or mailto:.", "error");
          return;
        }
        chain().extendMarkRange("link").setLink({ href }).run();
      }
      inspector.hidden = true;
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        apply();
      }
      if (event.key === "Escape") inspector.hidden = true;
    });
    inspector.replaceChildren(
      el("span", "editor-label label", "Link"),
      input,
      button("Apply", "Apply the link", apply, "editor-button editor-button--text"),
      button("Remove", "Remove the link", () => {
        chain().extendMarkRange("link").unsetLink().run();
        inspector.hidden = true;
      }, "editor-button editor-button--text"),
    );
    inspector.hidden = false;
    input.focus();
  };

  const openFigureInspector = () => {
    const attrs = editor.getAttributes("figure") as { alt?: string | null; caption?: string | null };
    const alt = Object.assign(document.createElement("input"), { type: "text", value: attrs.alt ?? "", maxLength: 500 });
    const caption = Object.assign(document.createElement("input"), { type: "text", value: attrs.caption ?? "", maxLength: 500 });
    alt.setAttribute("aria-label", "Description for screen readers");
    caption.setAttribute("aria-label", "Caption");
    alt.placeholder = "What the picture shows";
    caption.placeholder = "Caption under the picture (optional)";
    const apply = () => {
      chain().updateAttributes("figure", { alt: alt.value.trim() || null, caption: caption.value.trim() || null }).run();
      inspector.hidden = true;
    };
    inspector.replaceChildren(
      el("span", "editor-label label", "Picture"),
      alt,
      caption,
      button("Apply", "Apply the picture's description and caption", apply, "editor-button editor-button--text"),
    );
    inspector.hidden = false;
    alt.focus();
  };

  /* Pictures: a hidden file input behind the button, one upload per file. */
  const fileInput = Object.assign(document.createElement("input"), { type: "file", accept: "image/*", multiple: true });
  fileInput.hidden = true;
  let uploadCounter = 0;

  const upload = async (file: File) => {
    const local = `local-${Date.now()}-${uploadCounter++}`;
    chain().insertContent({ type: "figure", attrs: { upload: local } }).run();
    try {
      const answer = await api(key, "media", {
        method: "POST",
        headers: { "content-type": file.type || "application/octet-stream" },
        body: file,
      });
      updateFigures(editor, (attrs) => attrs.upload === local, { upload: answer.uploadId });
      say(`"${file.name}" is being prepared. It appears in the text when it is ready.`);
    } catch (error) {
      updateFigures(editor, (attrs) => attrs.upload === local, { failed: true });
      const reason =
        error instanceof ApiError && error.status === 413
          ? "it is larger than 20 MB"
          : error instanceof ApiError && error.status === 415
            ? "it is not a picture the site can publish"
            : "it could not be uploaded";
      say(`"${file.name}" was not added: ${reason}.`, "error");
    }
    refresh();
  };

  fileInput.addEventListener("change", () => {
    for (const file of fileInput.files ?? []) void upload(file);
    fileInput.value = "";
  });

  toolbar.append(
    group(blockType),
    group(
      toggle("B", "Bold", () => chain().toggleBold().run(), () => editor.isActive("bold"), "is-bold"),
      toggle("I", "Italic", () => chain().toggleItalic().run(), () => editor.isActive("italic"), "is-italic"),
      toggle("U", "Underline", () => chain().toggleUnderline().run(), () => editor.isActive("underline"), "is-underline"),
      toggle("S", "Strikethrough", () => chain().toggleStrike().run(), () => editor.isActive("strike"), "is-strike"),
    ),
    group(fontPicker, sizePicker),
    group(
      toggle("•", "Bulleted list", () => chain().toggleBulletList().run(), () => editor.isActive("bulletList")),
      toggle("1.", "Numbered list", () => chain().toggleOrderedList().run(), () => editor.isActive("orderedList")),
      button("—", "Section break", () => chain().setHorizontalRule().run()),
    ),
    group(
      toggle("⇤", "Align left", () => chain().setTextAlign("left").run(), () => false),
      toggle("↔", "Centre", () => chain().setTextAlign("center").run(), () => editor.isActive({ textAlign: "center" })),
      toggle("⇥", "Align right", () => chain().setTextAlign("right").run(), () => editor.isActive({ textAlign: "right" })),
    ),
    group(
      toggle("Link", "Link", openLinkInspector, () => editor.isActive("link"), "editor-button--text"),
      button("Picture", "Add a picture", () => fileInput.click(), "editor-button editor-button--text"),
      fileInput,
    ),
    group(
      button("↶", "Undo", () => chain().undo().run()),
      button("↷", "Redo", () => chain().redo().run()),
    ),
  );

  /* ------------------------------------------------------------ actions */

  const previewButton = button("Preview", "Show the article as the site will", () => togglePreview(), "editor-action");
  const publishButton = button("Publish", "Publish the article", () => void publish(), "editor-action editor-action--primary");
  const actions = el("div", "editor-actions");
  const viewLink = el("a", "editor-view") as HTMLAnchorElement;
  viewLink.hidden = true;
  viewLink.textContent = "View it on the site";
  viewLink.target = "_blank";
  viewLink.rel = "noopener";
  actions.append(viewLink, previewButton, publishButton);

  /* ------------------------------------------------------------ state */

  let expired = false;
  let publishing = false;

  function refresh() {
    const { pending, failed } = figureStates(editor);
    publishButton.disabled = expired || publishing || pending.length > 0;
    publishButton.textContent = publishedId ? "Publish changes" : "Publish";
    if (pending.length > 0) publishButton.title = "Waiting for pictures to finish";
    else if (failed > 0) publishButton.title = "Remove the pictures that failed first";
    else publishButton.title = "Publish the article";

    for (const [element, active] of toggles) element.setAttribute("aria-pressed", String(active()));

    const level = editor.isActive("heading", { level: 2 })
      ? "h2"
      : editor.isActive("heading", { level: 3 })
        ? "h3"
        : editor.isActive("heading", { level: 4 })
          ? "h4"
          : editor.isActive("blockquote")
            ? "quote"
            : "p";
    blockType.value = level;
    const style = editor.getAttributes("textStyle") as { fontFamily?: string; fontSize?: string };
    fontPicker.value = style.fontFamily ?? "";
    sizePicker.value = style.fontSize ?? "";

    if (editor.isActive("figure") && inspector.hidden) openFigureInspector();
  }
  editor.on("selectionUpdate", refresh);
  editor.on("transaction", () => {
    for (const [element, active] of toggles) element.setAttribute("aria-pressed", String(active()));
  });

  const tick = () => {
    expired = Date.parse(session.expiresAt) <= Date.now();
    expiry.textContent = expired
      ? "This link has expired"
      : `Link valid until ${clock(session.expiresAt)} · ${left(session.expiresAt)}`;
    if (expired) say(`This link has expired. Your text is kept in this browser. ${ASK_THE_BOT}`, "error");
    refresh();
  };
  tick();
  window.setInterval(tick, 30_000);

  /* Pictures being sanitised are asked after until they are ready or have failed. */
  window.setInterval(async () => {
    for (const uploadId of figureStates(editor).pending) {
      if (uploadId.startsWith("local-")) continue;
      try {
        const answer = await api(key, `media/${uploadId}`);
        if (answer.status === "ready") {
          updateFigures(editor, (attrs) => attrs.upload === uploadId, { src: answer.src, upload: null });
          say("A picture is ready. Select it to describe it or give it a caption.");
        } else if (answer.status === "failed") {
          updateFigures(editor, (attrs) => attrs.upload === uploadId, { failed: true });
          say("A picture could not be processed. Select it, delete it, and try another.", "error");
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          updateFigures(editor, (attrs) => attrs.upload === uploadId, { failed: true });
        }
      }
      refresh();
    }
  }, POLL_MS);

  /* ------------------------------------------------------------ preview and publish */

  function currentRecord(doc: RichDoc): ActivityRecord {
    const media: ActivityMedia[] = docFigures(doc).map((figure) => ({
      type: "image",
      src: figure.src,
      alt: figure.alt,
      caption: figure.caption,
    }));
    return {
      id: publishedId ?? "preview",
      title: title.value.trim() || "Untitled",
      summary: summary.value.trim() || null,
      eventDate: eventDate.value || null,
      tags: tags.value.split(",").map((tag) => tag.trim()).filter(Boolean),
      media: [...media, ...(record?.media ?? []).filter((item) => item.type === "video")],
      bodyFormat: "rich",
      body: null,
    };
  }

  function documentForPublish(): RichDoc | null {
    const cleaned = cleanDoc(editor.getJSON(), { allowSrc: () => true });
    if (!cleaned.ok) {
      say(`The article cannot be published as it is: ${cleaned.problem}.`, "error");
      return null;
    }
    return cleaned.doc;
  }

  function togglePreview() {
    if (preview.hidden) {
      const doc = documentForPublish();
      if (!doc) return;
      preview.replaceChildren(renderRecord(currentRecord(doc), { heading: "h1", doc }));
      preview.hidden = false;
      surface.hidden = true;
      toolbar.hidden = true;
      inspector.hidden = true;
      previewButton.textContent = "Back to editing";
    } else {
      preview.hidden = true;
      surface.hidden = false;
      toolbar.hidden = false;
      previewButton.textContent = "Preview";
      editor.commands.focus();
    }
  }

  async function publish() {
    if (title.value.trim() === "") {
      say("The article needs a title.", "error");
      title.focus();
      return;
    }
    const { failed } = figureStates(editor);
    if (failed > 0) {
      say("Remove the pictures that could not be processed before publishing.", "error");
      return;
    }
    const doc = documentForPublish();
    if (!doc) return;

    publishing = true;
    refresh();
    say("Publishing…");
    try {
      const answer = await api(key, "publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: title.value,
          summary: summary.value,
          eventDate: eventDate.value,
          tags: tags.value.split(","),
          doc,
        }),
      });
      publishedId = answer.recordId as string;
      publishedHref = answer.url as string;
      writeDraft(slot, null);
      say(answer.created ? "Published. The bot has sent you the link too." : "Saved. The article on the site now reads as above.", "done");
      heading.textContent = `Update "${title.value.trim()}"`;
    } catch (error) {
      const body = error instanceof ApiError ? error.body : {};
      if (body.status === "expired") {
        expired = true;
        say(`This link has expired, so nothing was published. Your text is kept in this browser. ${ASK_THE_BOT}`, "error");
      } else if (body.status === "invalid") {
        say(`Not published: ${String(body.problem)}`, "error");
      } else if (body.status === "gone") {
        say("Not published: the article this link was for is no longer on the site.", "error");
      } else {
        say("Not published: the site could not be reached. Try again in a moment.", "error");
      }
    } finally {
      publishing = false;
      if (publishedHref) {
        viewLink.href = publishedHref;
        viewLink.hidden = false;
      }
      refresh();
    }
  }

  if (publishedHref) {
    viewLink.href = publishedHref;
    viewLink.hidden = false;
  }

  /* ------------------------------------------------------------ layout */

  const head = el("header", "editor-head");
  head.append(heading, expiry);

  root.replaceChildren(head, status, fields, toolbar, inspector, surface, preview, actions);

  if (restored) {
    const discard = button("Discard them", "Discard the unsaved changes and start from the published article", () => {
      writeDraft(slot, null);
      window.location.reload();
    }, "editor-button editor-button--text");
    say(`Restored the changes you had not published yet (from ${clock(restored.savedAt)}).`);
    status.append(" ", discard);
  }
  refresh();
}

applyDesignTokens();
const root = document.querySelector<HTMLElement>("#app");
if (root) {
  root.classList.add("editor");
  void start(root);
}
