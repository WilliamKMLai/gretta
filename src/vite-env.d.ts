/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set to '1' by .env.browser (`pnpm dev:web`) to force browser dev mode. */
  readonly VITE_OFFICE_MOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
