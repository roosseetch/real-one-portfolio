/**
 * The key from the bot's link, taken off the address the moment the page loads.
 *
 * The link is `/admin/?key=crt_…`, and the key in it can publish on the site
 * for four hours. Left in the address it would sit in the browser's history,
 * be copied with the URL by anyone who shares their screen or the tab, and go
 * out in a Referer header. So it is read once, the address is rewritten
 * without it, and the tab keeps it in sessionStorage — which survives a reload
 * and dies with the tab.
 */

const STORAGE_KEY = "article-editor-key";
const KEY_SHAPE = /^(crt|upd)_[0-9a-z]{32}$/;

export function takeKey(win: Window = window): string | null {
  const url = new URL(win.location.href);
  const fromLink = url.searchParams.get("key");

  if (fromLink !== null) {
    url.searchParams.delete("key");
    win.history.replaceState(win.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    if (!KEY_SHAPE.test(fromLink)) return null;
    try {
      win.sessionStorage.setItem(STORAGE_KEY, fromLink);
    } catch {
      // Storage refused (a private window, blocked site data). The key still
      // works for as long as this page stays open.
    }
    return fromLink;
  }

  try {
    const kept = win.sessionStorage.getItem(STORAGE_KEY);
    return kept !== null && KEY_SHAPE.test(kept) ? kept : null;
  } catch {
    return null;
  }
}

export function forgetKey(win: Window = window): void {
  try {
    win.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing kept, nothing to forget.
  }
}
