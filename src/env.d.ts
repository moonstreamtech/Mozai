/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly MOZAI_ADMOB_APP_ID?: string;
  readonly MOZAI_ADMOB_BANNER_UNIT_ID?: string;
  readonly MOZAI_ADMOB_REWARDED_ID?: string;
  readonly MOZAI_DEBUG?: string;
  /**
   * Always-on boot diagnostics strip. Default ON for now so blank-
   * screen failures on device are visibly debuggable. Set to '0' or
   * 'false' to disable. Will be removed once the device boot is
   * stable.
   */
  readonly VITE_BOOT_DEBUG?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
