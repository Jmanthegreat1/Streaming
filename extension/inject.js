// Runs in the PAGE's own context (MAIN world) so it can see the player's network
// calls. We hook fetch/XHR to spot the video manifest (.m3u8 / .mpd) and the
// media segments — the foundation the prefetch/look-ahead needs. URLs are passed
// to the extension's content script via postMessage. We only observe, never block.
(function () {
  const seen = new Set();

  function report(url, kind) {
    if (!url || typeof url !== "string") return;
    if (seen.has(url)) return;
    const isManifest = /\.m3u8(\?|#|$)/i.test(url) || /\.mpd(\?|#|$)/i.test(url);
    const isSegment = /\.(ts|m4s|mp4|cmf[vt]?)(\?|#|$)/i.test(url);
    if (!isManifest && !isSegment) return;
    seen.add(url);
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
