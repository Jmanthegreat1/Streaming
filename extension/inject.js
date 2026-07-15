// Runs in the PAGE's own context (MAIN world) so it can see the player's network
// calls. We hook fetch/XHR to spot the video manifest (.m3u8 / .mpd) and the
// media segments — the foundation the prefetch/look-ahead needs. URLs are passed
// to the extension's content script via postMessage. We only observe, never block.
(function () {
  const seen = new Set();
  const manifestLast = new Map(); // url -> last report time

  function report(url, kind) {
    if (!url || typeof url !== "string") return;
    const isManifest = /\.m3u8(\?|#|$)/i.test(url) || /\.mpd(\?|#|$)/i.test(url);
    const isSegment = /\.(ts|m4s|mp4|cmf[vt]?)(\?|#|$)/i.test(url);
    if (!isManifest && !isSegment) return;
    if (isManifest) {
      // A manifest re-request is a real signal — it's how we know which video
      // the player is on after an ad ends or an episode switch (the content
      // script adopts the FRESHEST manifest). Deduping it to once per page
      // made every re-request invisible and left the look-ahead engine off
      // for the rest of the page. Only rate-limit repeats.
      const now = Date.now();
      if (now - (manifestLast.get(url) || 0) < 3000) return;
      manifestLast.set(url, now);
    } else {
      if (seen.has(url)) return;
      seen.add(url);
    }
    window.postMessage(
      { __subtrans_stream: { url, kind: isManifest ? "manifest" : "segment" } },
      "*"
    );
  }

  try {
    const origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (input, init) {
        try {
          report(typeof input === "string" ? input : input && input.url);
        } catch (e) {}
        return origFetch.apply(this, arguments);
      };
    }
  } catch (e) {}

  try {
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        report(url);
      } catch (e) {}
      return origOpen.apply(this, arguments);
    };
  } catch (e) {}
})();
