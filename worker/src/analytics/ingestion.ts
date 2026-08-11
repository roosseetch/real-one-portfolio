/**
 * Where Amplitude events go, whoever is sending them.
 *
 * One constant rather than one per sender: the relay (proxy.ts) and the Worker's
 * own events (events.ts) must not be able to drift onto different hostnames, and
 * `scripts/no-deployment-values.test.ts` allows exactly this one.
 */
export const AMPLITUDE_HTTP_V2 = "https://api2.amplitude.com/2/httpapi";
