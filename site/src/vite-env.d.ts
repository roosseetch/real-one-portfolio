/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public Amplitude project API key; safe to embed in the browser bundle. */
  readonly VITE_AMPLITUDE_API_KEY?: string;
  /** First-party relay used only when the direct Amplitude request is blocked. */
  readonly VITE_AMPLITUDE_SERVER_URL?: string;
  readonly VITE_CONTENT_BASE_URL?: string;
  /** Public media bucket base URL; enables real photos in place of placeholders. */
  readonly VITE_MEDIA_BASE_URL?: string;
  /** Worker origin the contact form posts to. Unset renders the form as unavailable. */
  readonly VITE_WORKER_BASE_URL?: string;
  /** Public Turnstile site key for the contact form's challenge. Unset renders the form as unavailable. */
  readonly VITE_TURNSTILE_SITE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
