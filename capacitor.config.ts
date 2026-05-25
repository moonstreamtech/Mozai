import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.moonstreamtech.mozai',
  appName: 'Mozai',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
  },
  plugins: {
    // AdMob app id is read at native init time from
    // android/app/src/main/AndroidManifest.xml via a manifest placeholder
    // (set by the build script from MOZAI_ADMOB_APP_ID — see README).
    // No client-side initialisation token is needed here.
  },
};

export default config;
