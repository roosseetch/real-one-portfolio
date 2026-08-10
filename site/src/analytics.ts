import { AmplitudeBrowser } from "@amplitude/analytics-browser";

import { trackEngagement } from "./engagement";

type TransportProvider = AmplitudeBrowser["config"]["transportProvider"];
type Payload = Parameters<TransportProvider["send"]>[1];

/**
 * The instance initializeAnalytics started, or null in a deployment that ships
 * without analytics. Module-level so a page can record an event of its own
 * without every renderer being handed an SDK it mostly does not use.
 */
let instance: AmplitudeBrowser | null = null;

/**
 * Records one event, or does nothing at all when no API key was configured.
 *
 * A no-op rather than an optional dependency: a page that has to check whether
 * analytics exists before saying something happened ends up checking in some
 * places and not others.
 */
export function trackEvent(eventType: string, properties?: Record<string, unknown>): void {
  instance?.track(eventType, properties);
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

  // Transport state, kept here rather than inside the wrapper so the unload
  // path can set it whether or not the wrapper ever got installed.
  let blocked = false;
  let unloading = false;

  /**
   * sendBeacon is the only upload that survives a page being torn down, and the
   * summary event that makes a session's length truthful is sent exactly then.
   * A JSON content type would make this a preflighted request, and a preflight
   * during unload is not reliably delivered; text/plain keeps it a simple one.
   * Neither Amplitude's ingestion API nor the Worker relay reads the header.
   */
  function sendViaBeacon(url: string, payload: Payload): null {
    navigator.sendBeacon(url, new Blob([JSON.stringify(payload)], { type: "text/plain" }));
    // A beacon only ever confirms that the browser queued the request, never
    // that it landed, so null—"outcome unknown"—is the truthful answer. The SDK
    // takes it as reason to drop the batch rather than retry it, which is what
    // this page wants: there is no next attempt once it has been torn down.
    return null;
  }

  function withRelayFallback(direct: TransportProvider, relay: string | undefined): TransportProvider {
    return {
      async send(serverUrl, payload, enableRequestBodyCompression) {
        if (unloading) return sendViaBeacon(blocked && relay ? relay : serverUrl, payload);
        if (blocked && relay) return direct.send(relay, payload, enableRequestBodyCompression);

        try {
          return await direct.send(serverUrl, payload, enableRequestBodyCompression);
        } catch (error) {
          if (!relay) throw error;
          // An extension or DNS block rejects the request outright instead of
          // answering it, and will reject every later batch the same way. Latch
          // so the rest of the visit stops paying for the doomed attempt.
          blocked = true;
          return direct.send(relay, payload, enableRequestBodyCompression);
        }
      },
    };
  }

  const amplitude = new AmplitudeBrowser();
  instance = amplitude;
  const initialization = amplitude.init(apiKey, {
    // Ten seconds rather than the default one. A visit's engagement events then
    // coalesce into a handful of uploads, which matters because an ad-blocked
    // visitor's uploads each cost a Worker invocation on the relay.
    flushIntervalMillis: 10_000,
    // Local settings are enough for this small site. Do not fetch a second
    // Amplitude hostname for settings that are already fixed here.
    remoteConfig: { fetchRemoteConfig: false },
    autocapture: {
      attribution: true,
      fileDownloads: true,
      formInteractions: false,
      pageViews: true,
      sessions: true,
      elementInteractions: true,
      networkTracking: false,
      webVitals: false,
      frustrationInteractions: false
    }
  });

  const install = () => {
    try {
      const config = amplitude.config;
      config.transportProvider = withRelayFallback(config.transportProvider, relayUrl);
    } catch {
      // No config means init never got far enough to have a transport to wrap.
    }
  };
  // Install on both settle paths. Handling only fulfilment left a failed init
  // with no fallback and no beacon, silently.
  void initialization.promise.then(install, install);

  window.addEventListener("pageshow", (event) => {
    // Restored from the back-forward cache: the page is live again, so undo the
    // one-way switch to beacons that pagehide made.
    if (event.persisted) unloading = false;
  });

  trackEngagement({
    track: (eventType, properties) => void amplitude.track(eventType, properties),
    leaving: () => {
      unloading = true;
    },
    flush: () => void amplitude.flush(),
  });
}
