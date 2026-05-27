/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly MOZAI_ADMOB_BANNER_ID?: string;
  readonly MOZAI_ADMOB_REWARDED_ID?: string;
  /**
   * Force test creatives on every plugin call even when real ad-unit
   * IDs are configured. Set this to `1` on developer / QA builds so
   * tapping ads on the test device can't get the AdMob account
   * flagged for invalid traffic.
   */
  readonly MOZAI_ADMOB_TESTING?: string;
  readonly MOZAI_DEBUG?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
