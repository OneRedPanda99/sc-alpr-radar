/**
 * Overpass with hedged fallbacks, for areas the prebuilt tiles don't cover.
 * The public servers are free and often overloaded: one answers 502, another
 * hangs without replying. Rather than wait out each in turn, ask the first,
 * bring in the next if it errors or hasn't answered within a couple of
 * seconds, and take whichever answers first (cancelling the rest).
 */
const SERVERS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

/** Give a server this long before also asking the next one. */
const HEDGE_MS = 2500;
/** Stop waiting on any one server after this. */
const PER_SERVER_MS = 20000;

export function overpassQuery<T>(query: string, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const ctrls: AbortController[] = [];
    let next = 0;
    let failed = 0;
    let done = false;
    let lastErr: unknown = null;
    let hedge: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      done = true;
      if (hedge) clearTimeout(hedge);
      for (const c of ctrls) c.abort();
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (done) return;
      finish();
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort);

    const launch = () => {
      if (done || next >= SERVERS.length) return;
      const url = SERVERS[next++];
      const ctrl = new AbortController();
      ctrls.push(ctrl);
      const timer = setTimeout(() => ctrl.abort(), PER_SERVER_MS);
      if (hedge) clearTimeout(hedge);
      hedge = setTimeout(launch, HEDGE_MS);
      fetch(url, { method: "POST", body: new URLSearchParams({ data: query }), signal: ctrl.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(`Overpass ${res.status}`);
          const json = (await res.json()) as T;
          if (done) return;
          finish();
          resolve(json);
        })
        .catch((e) => {
          if (done) return;
          lastErr = e;
          failed++;
          if (failed >= SERVERS.length) {
            finish();
            reject(lastErr ?? new Error("Overpass unavailable"));
          } else {
            launch(); // Don't wait out the hedge timer after a hard failure.
          }
        })
        .finally(() => clearTimeout(timer));
    };
    launch();
  });
}
