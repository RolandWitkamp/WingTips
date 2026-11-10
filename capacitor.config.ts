import type { CapacitorConfig } from '@capacitor/cli';

// Android app wrapper (Capacitor) around the same web build that runs on wingtips.nl.
// Build: npm run build && npx cap sync android, then open android/ in Android Studio.
const config: CapacitorConfig = {
  appId: 'nl.wingtips.app',
  appName: 'WingTips',
  webDir: 'dist',
  android: {
    // Same navy as the app's top bar, so there's no white flash behind the WebView on start.
    backgroundColor: '#003082',
  },
};

export default config;
