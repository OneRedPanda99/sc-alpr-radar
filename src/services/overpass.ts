/**
 * Overpass with fallbacks. The public servers are free and often overloaded:
 * one answers 502, another hangs without replying. Try each in turn, give up
 * on any that hasn't answered in time, and only fail once all of them have.
 */
const SERVERS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

const PER_SERVER_MS = 20000;

export async function overpassQuery<T>(query: string, signal?: AbortSignal): Promise<T> {
  let lastErr: unknown = null;
  for (const url of SERVERS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PER_SERVER_MS);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort);
    try {
      const res = await fetch(url, {
        method: "POST",
        body: new URLSearchParams({ data: query }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      // The caller gave up (the map moved on): stop, don't try the next server.
      if (signal?.aborted) throw e;
      lastErr = e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  throw lastErr ?? new Error("Overpass unavailable");
}
