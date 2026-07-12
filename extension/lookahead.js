// Look-ahead sync engine: a hidden <video> plays the SAME HLS stream a few
// seconds AHEAD of the visible one (via the bundled hls.js — the page's own
// player uses MSE the same way, so CORS is already permitted). content.js
// scans the shadow's frames and stores timed cues here; the overlay then shows
// each English line at the exact moment its Hebrew appears on the real video.
//
// If anything makes look-ahead impossible (no manifest, DRM, a live broadcast
// with no future to read, unreadable frames), this module parks itself in
// "unavailable" with a human-readable reason and the instant-OCR path keeps
// working exactly as before.
window.__subtransLA = (() => {
  const LOOKAHEAD = 8; // seconds the shadow runs ahead of the visible video
  const SLACK = 1.5; // allowed drift before we re-seek / hold the shadow

  let shadow = null;
  let hls = null;
  let manifestUrl = null;
  let getMain = () => null;
  let syncTimer = null;

  let gen = 0; // bumped on every flush; stale async results are dropped by it
  let cues = []; // {start, end|null, text} sorted by start (video time, seconds)
  let coveredUntil = 0; // shadow time scanned so far — coverage watermark
  let coverageStart = Infinity; // earliest shadow time scanned since the last flush
  let stState = "off"; // off | building | synced | unavailable
  let stDetail = "";
  let lastMainTime = -1;

  function setState(s, d) {
    stState = s;
    stDetail = d || "";
  }

  function init(mainGetter) {
    getMain = mainGetter;
  }

  function active() {
    return stState === "building" || stState === "synced";
  }

  function video() {
    return shadow;
  }

  function start(url) {
    if (shadow && manifestUrl === url) return; // already running on this stream
    if (!url) return fail("no video stream found on this page");
    if (!window.Hls || !Hls.isSupported()) return fail("HLS engine unsupported in this browser");
    stop(true);
    manifestUrl = url;
    shadow = document.createElement("video");
    shadow.setAttribute("data-subtrans-shadow", "1"); // content.js must never mistake it for the page's video
    shadow.muted = true;
    shadow.playsInline = true;
    shadow.preload = "auto";
    shadow.style.cssText =
      "position:fixed;left:-99999px;top:0;width:320px;height:180px;pointer-events:none;opacity:0;";
    document.documentElement.appendChild(shadow);

    hls = new Hls({ maxBufferLength: 15, backBufferLength: 5 });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data || !data.fatal) return;
      const drm = /key|drm/i.test(String(data.details || ""));
      fail(drm ? "this stream is copy-protected (DRM)" : "stream error: " + data.details);
    });
    hls.on(Hls.Events.LEVEL_LOADED, (_, data) => {
      // A live broadcast has no future to read ahead of.
      if (data && data.details && data.details.live) fail("live broadcast — nothing to read ahead");
    });
    hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
      // Pin the smallest rendition that's still sharp enough to OCR (≥~720p) —
      // ABR flapping would waste bandwidth and confuse the scanner.
      const levels = (data && data.levels) || [];
      let pick = -1, bestH = Infinity;
      levels.forEach((l, i) => {
        const h = l.height || 0;
        if (h >= 700 && h < bestH) { bestH = h; pick = i; }
      });
      if (pick < 0 && levels.length) {
        pick = 0;
        levels.forEach((l, i) => { if ((l.height || 0) > (levels[pick].height || 0)) pick = i; });
      }
      if (pick >= 0) hls.currentLevel = pick;
      setState("building", "buffering the stream ahead");
      sync(true);
    });
    hls.loadSource(url);
    hls.attachMedia(shadow);
    setState("building", "loading the stream");
    syncTimer = setInterval(() => sync(false), 500);
    console.log("[SubTrans] look-ahead: shadow player starting on", url);
  }

  function fail(why) {
    stop(true);
    setState("unavailable", why);
    console.log("[SubTrans] look-ahead unavailable:", why);
  }

  function stop(keepState) {
    clearInterval(syncTimer);
    syncTimer = null;
    if (hls) {
      try { hls.destroy(); } catch (e) {}
      hls = null;
    }
    if (shadow) {
      shadow.remove();
      shadow = null;
    }
    manifestUrl = null;
    flush();
    lastMainTime = -1;
    if (!keepState) setState("off");
  }

  function flush() {
    gen++;
    cues = [];
    coveredUntil = 0;
    coverageStart = Infinity;
  }

  function sync(force) {
    const m = getMain();
    if (!m || !shadow) return;
    // A real seek (not playback jitter) invalidates everything read ahead.
    if (lastMainTime >= 0 && Math.abs(m.currentTime - lastMainTime) > 3) {
      flush();
      force = true;
    }
    lastMainTime = m.currentTime;
    shadow.playbackRate = m.playbackRate || 1;
    const target = Math.min(
      m.currentTime + LOOKAHEAD,
      (isFinite(shadow.duration) ? shadow.duration : Infinity) - 0.4
    );
    const lead = shadow.currentTime - m.currentTime;
    // Fell behind (seek, stall, startup): jump forward. Got too far ahead
    // (main is buffering): just hold — never seek backward, that would
    // re-scan ground we already covered.
    if (force || lead < LOOKAHEAD - SLACK) {
      try { shadow.currentTime = Math.max(0, target); } catch (e) {}
    }
    const wantPlay = !m.paused && !m.ended && lead <= LOOKAHEAD + SLACK;
    if (wantPlay && shadow.paused) shadow.play().catch(() => {});
    else if (!wantPlay && !shadow.paused) shadow.pause();
    if (stState === "building" && coveredUntil > m.currentTime + 0.5) setState("synced");
    // Drop cues we've played well past.
    if (cues.length && cues[0].end != null && cues[0].end < m.currentTime - 60) {
      cues = cues.filter((c) => c.end == null || c.end >= m.currentTime - 60);
    }
  }

  // ---- cue store (all times are video-time seconds) ----
  function currentGen() {
    return gen;
  }

  function markScanned(g, t) {
    if (g !== gen) return;
    // Ignore a reading taken mid-reseek (stale shadow clock).
    const m = getMain();
    if (m && (t < m.currentTime - 1 || t > m.currentTime + LOOKAHEAD + 4)) return;
    if (t < coverageStart) coverageStart = t;
    if (t > coveredUntil) coveredUntil = t;
  }

  function addCue(g, cue) {
    if (g !== gen || !cue || !cue.text) return;
    cues.push(cue);
    cues.sort((a, b) => a.start - b.start);
  }

  function closeCue(g, start, end) {
    if (g !== gen) return;
    for (const c of cues) if (c.start === start) { c.end = end; return; }
  }

  // Is video-time t inside the region we've actually read ahead? The scan
  // starts LOOKAHEAD seconds in (and restarts after every seek), so the range
  // has a beginning too — before it, the instant path must keep covering.
  function covers(t) {
    return active() && t >= coverageStart - 0.1 && t < coveredUntil - 0.25;
  }

  function cueAt(t) {
    for (let i = cues.length - 1; i >= 0; i--) {
      const c = cues[i];
      if (c.start <= t + 0.05 && (c.end == null || t < c.end)) return c.text;
      if (c.start < t - 45) break; // sorted; nothing earlier can still be showing
    }
    return "";
  }

  function status() {
    const m = getMain();
    return {
      state: stState,
      detail: stDetail,
      cues: cues.length,
      lead: shadow && m ? Math.max(0, shadow.currentTime - m.currentTime) : 0,
      coveredUntil,
    };
  }

  return {
    init, start, stop, fail, active, video, status,
    gen: currentGen, markScanned, addCue, closeCue, covers, cueAt,
  };
})();
