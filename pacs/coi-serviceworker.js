/*
  Cross-origin isolation for a static host that cannot set headers.

  WHY THIS FILE EXISTS. onnxruntime-web runs the model on the CPU through WebAssembly
  whenever WebGPU is unavailable, and a multithreaded WASM build needs SharedArrayBuffer.
  The browser only exposes SharedArrayBuffer to a cross-origin-isolated page, which
  requires two response headers:

      Cross-Origin-Opener-Policy:   same-origin
      Cross-Origin-Embedder-Policy: require-corp

  GitHub Pages serves a fixed header set and offers no way to add them. A service worker
  can, because it sits between the page and the network and may rewrite the responses it
  passes through. So the first load registers this worker and reloads once; from then on
  every response carries the headers, SharedArrayBuffer exists, and ORT can use as many
  threads as the machine reports.

  WHAT IT COSTS. `require-corp` means every cross-origin subresource must opt in with
  CORP/CORS or it is blocked. This site serves its own model, its own ORT build and its
  own images, so there is nothing to break -- but that is the thing to check first if an
  external asset ever stops loading.

  Derived from the widely used coi-serviceworker pattern (gzuidhof, MIT).
*/

if (typeof window === "undefined") {
  // ── worker side ─────────────────────────────────────────────────────────────
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

  self.addEventListener("fetch", event => {
    const req = event.request;
    // A navigation preload response arrives already consumed; let it through untouched.
    if (req.cache === "only-if-cached" && req.mode !== "same-origin") return;

    event.respondWith(
      fetch(req)
        .then(res => {
          if (res.status === 0) return res;          // opaque: nothing to rewrite
          const headers = new Headers(res.headers);
          headers.set("Cross-Origin-Embedder-Policy", "require-corp");
          headers.set("Cross-Origin-Opener-Policy", "same-origin");
          // same-origin assets must also declare themselves embeddable
          headers.set("Cross-Origin-Resource-Policy", "cross-origin");
          return new Response(res.body, {
            status: res.status, statusText: res.statusText, headers,
          });
        })
        .catch(e => console.error("[coi] ", e))
    );
  });
} else {
  // ── page side ───────────────────────────────────────────────────────────────
  (() => {
    if (window.crossOriginIsolated) return;           // already isolated: nothing to do
    if (!window.isSecureContext) return;              // http: the API is unavailable
    if (!("serviceWorker" in navigator)) return;

    navigator.serviceWorker.register(window.document.currentScript.src)
      .then(reg => {
        reg.addEventListener("updatefound", () => window.location.reload());
        // A worker that is active but did not control THIS load cannot have added the
        // headers to it, so one reload is needed -- and exactly one, guarded by a flag
        // so a failure to isolate cannot become a reload loop.
        if (reg.active && !navigator.serviceWorker.controller) {
          if (!sessionStorage.getItem("coiReloaded")) {
            sessionStorage.setItem("coiReloaded", "1");
            window.location.reload();
          }
        }
      })
      .catch(e => console.warn("[coi] registration failed, staying single-threaded:", e));
  })();
}
