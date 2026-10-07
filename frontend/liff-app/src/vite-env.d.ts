/// <reference types="vite/client" />

// Public, browser-visible values only. Never add secrets here.
interface ImportMetaEnv {
  readonly VITE_APP_TITLE?: string;
  readonly VITE_LIFF_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
