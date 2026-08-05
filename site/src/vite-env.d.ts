/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public Amplitude project API key; safe to embed in the browser bundle. */
  readonly VITE_AMPLITUDE_API_KEY?: string;
  readonly VITE_CONTENT_BASE_URL?: string;
  /** Public media bucket base URL; enables real photos in place of placeholders. */
  readonly VITE_MEDIA_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
