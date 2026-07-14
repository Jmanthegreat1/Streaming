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
  const SLACK = 1.5; // allowed drift before we hold / speed up the shadow
  const CATCHUP_RATE = 1.5; // shadow speed while rebuilding its lead (never seeks forward)
  const MAX_OPEN_CUE = 7; // a cue whose end was never observed can't linger past this

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
  let netPaused = false; // shadow downloads halted so the main video gets the pipe
  let pendingSeek = false; // a main-video seek is waiting for the main to rebuffer first

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

    // Keep the shadow CHEAP: it shares bandwidth and CPU with the visible
    // player, and on a laptop two big decodes make the real video stutter.
    hls = new Hls({ maxBufferLength: 10, backBufferLength: 4 });
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
      // Pin the smallest rendition that's still readable for OCR (~480p —
      // subtitle text is large). Higher levels double the bandwidth + decode
      // cost and make the REAL video lag; ABR flapping would confuse the scanner.
      const levels = (data && data.levels) || [];
      let pick = -1, bestH = Infinity;
      levels.forEach((l, i) => {
        const h = l.height || 0;
        if (h >= 470 && h < bestH) { bestH = h; pick = i; }
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
    netPaused = false;
    pendingSeek = false;
    if (!keepState) setState("off");
  }

  // The main video owns the network. Every segment the shadow pulls while the
  // main player is trying to buffer prolongs that buffering — over a slow or
  // VPN'd connection the two re-buffering side by side after a seek can pin
  // the real video at "loading" indefinitely.
  function setNet(on) {
    if (!hls || on === !netPaused) return;
    try {
      if (on) hls.startLoad();
      else hls.stopLoad();
    } catch (e) {}
    netPaused = !on;
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
      pendingSeek = true;
      if (active()) setState("building", "re-reading after a jump");
    }
    lastMainTime = m.currentTime;
    // The shadow must be playing the SAME video. If the durations disagree,
    // we latched onto a different stream (a pre-roll ad's manifest, or the
    // previous episode on an SPA navigation) — its cues would be wrong text
    // at wrong times. Bail to instant mode; a fresh manifest restarts us.
    if (
      isFinite(m.duration) && m.duration > 0 &&
      isFinite(shadow.duration) && shadow.duration > 0 &&
      Math.abs(m.duration - shadow.duration) > 3
    ) {
      return fail("stream doesn't match the video (ad or different edit)");
    }
    // Main video starved of data (buffering after a seek, or a mid-play
    // stall): stop the shadow's downloads and just wait — the pipe belongs
    // to the real player until it's healthy again.
    if (m.readyState < 3) {
      setNet(false);
      if (!shadow.paused) shadow.pause();
      return;
    }
    setNet(true);
    const dur = isFinite(shadow.duration) && shadow.duration > 0 ? shadow.duration : Infinity;
    // Seek ONLY on a fresh start / after a real main-video seek — and to the
    // main video's own position, so coverage is contiguous from the head.
    // Mid-play the shadow must NEVER jump forward to catch up: every jump
    // leaves a hole of subtitles that were simply never read (missing lines)
    // and strands the line that was open at jump time with a far-too-late end
    // (a stale sentence lingering over different dialogue). Instead it catches
    // up by PLAYING faster — 1.5x at 480p is cheap and closes the gap smoothly.
    // One seek exception: if the shadow fell BEHIND the live playhead (its
    // buffer starved while the main played on), jumping to the head skips only
    // ground that already played — nothing we'd ever scan — and 1.5x alone
    // could take minutes to close that gap.
    if (force || pendingSeek || shadow.currentTime - m.currentTime < -1.5) {
      pendingSeek = false;
      try { shadow.currentTime = Math.max(0, Math.min(m.currentTime + 0.3, dur - 0.4)); } catch (e) {}
    }
    const lead = shadow.currentTime - m.currentTime;
    shadow.playbackRate = (m.playbackRate || 1) * (lead < LOOKAHEAD - SLACK ? CATCHUP_RATE : 1);
    // The shadow keeps reading ahead even while the main video is paused —
    // that's what lets a held/paused video resume with its lines already
    // translated. Too far ahead: just hold (never seek backward, that would
    // re-scan ground we already covered).
    const wantPlay = !m.ended && lead <= LOOKAHEAD + SLACK && shadow.currentTime < dur - 0.3;
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
    if (cue.end != null) cue.end = Math.min(cue.end, cue.start + MAX_OPEN_CUE);
    cues.push(cue);
    cues.sort((a, b) => a.start - b.start);
  }

  function closeCue(g, start, end) {
    if (g !== gen) return;
    // A close that lands absurdly late (a stall between the line's start and
    // its observed end) must not stretch the cue — no subtitle runs longer
    // than MAX_OPEN_CUE.
    for (const c of cues) {
      if (c.start === start) { c.end = Math.min(end, c.start + MAX_OPEN_CUE); return; }
    }
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
      // A cue whose end was never observed still expires — an open cue must
      // not sit on screen through later (untranslated) dialogue.
      const end = c.end != null ? c.end : c.start + MAX_OPEN_CUE;
      if (c.start <= t + 0.05 && t < end) return c.text;
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
