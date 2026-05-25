/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly MOZAI_ADMOB_APP_ID?: string;
  readonly MOZAI_ADMOB_BANNER_UNIT_ID?: string;
  readonly MOZAI_DEBUG?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
