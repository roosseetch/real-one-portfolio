import * as amplitude from "@amplitude/analytics-browser";

/**
 * Starts Amplitude only when a project API key is supplied at build time.
 * VITE_ variables are embedded in the browser bundle, so only use Amplitude's
 * public project API key here—never a Secret Key.
 */
export function initializeAnalytics() {
  const apiKey = import.meta.env.VITE_AMPLITUDE_API_KEY;
  if (!apiKey) return;

  const serverUrl = import.meta.env.VITE_AMPLITUDE_SERVER_URL;

  amplitude.init(apiKey, {
    ...(serverUrl ? { serverUrl } : {}),
    // Local settings are enough for this small site. Avoid a second Amplitude
    // hostname that privacy tools can block while the event relay succeeds.
    remoteConfig: { fetchRemoteConfig: false },
    autocapture: {
      attribution: true,
      fileDownloads: true,
      formInteractions: false,
      pageViews: true,
      sessions: true,
      elementInteractions: false,
      networkTracking: false,
      webVitals: false,
      frustrationInteractions: false
    }
  });
}
