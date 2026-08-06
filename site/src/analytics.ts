import { AmplitudeBrowser } from "@amplitude/analytics-browser";

type TransportProvider = AmplitudeBrowser["config"]["transportProvider"];

function withBlockedRequestFallback(
  direct: TransportProvider,
  relayUrl: string,
): TransportProvider {
  return {
    async send(serverUrl, payload, enableRequestBodyCompression) {
      try {
        return await direct.send(serverUrl, payload, enableRequestBodyCompression);
      } catch {
        return direct.send(relayUrl, payload, enableRequestBodyCompression);
      }
    },
  };
}

/**
 * Starts Amplitude only when a project API key is supplied at build time.
 * VITE_ variables are embedded in the browser bundle, so only use Amplitude's
 * public project API key here—never a Secret Key.
 */
export function initializeAnalytics() {
  const apiKey = import.meta.env.VITE_AMPLITUDE_API_KEY;
  if (!apiKey) return;

  const relayUrl = import.meta.env.VITE_AMPLITUDE_SERVER_URL;
  const amplitude = new AmplitudeBrowser();
  const initialization = amplitude.init(apiKey, {
    // Local settings are enough for this small site. Do not fetch a second
    // Amplitude hostname for settings that are already fixed here.
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

  if (relayUrl) {
    void initialization.promise.then(
      () => {
        const direct = amplitude.config.transportProvider;
        amplitude.config.transportProvider = withBlockedRequestFallback(direct, relayUrl);
      },
      () => undefined,
    );
  }
}
