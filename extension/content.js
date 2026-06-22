// Runs on every page. Two ways to get subtitles:
//   TEXT mode — read native <track> cues or a DOM element you click.
//   OCR  mode — read burned-in subtitles from a region you draw, translate them,
//               and lay the English right over the original.
//
// OCR reads pixels straight from the <video> frame when possible (that frame
// doesn't contain our overlay, so we can cover the original cleanly). If the
// video can't be read into a canvas (cross-origin taint), it falls back to a
// tab screenshot, briefly hiding our overlay during each capture.

(() => {
  const DEFAULTS = {
    enabled: false,
    mode: "ocr", // "ocr" | "text"
    engine: "local", // "local" (on-device Tesseract) | "server"
    target: "en",
    source: "auto",
    lang: "heb",
    backendUrl: "",
    showOriginal: false,
    selector: null,
    ocrRegion: null, // {fx, fy, fw, fh} fractions of the viewport
  };
  const state = { ...DEFAULTS };
  const isTop = window === window.top; // OCR runs top-frame only

  let overlayEl = null;
  let lastText = "";
  const cache = new Map();

  function loadSettings() {
    chrome.storage.sync.get(DEFAULTS, (s) => {
      Object.assign(state, s);
      apply();
    });
  }
  chrome.storage.onChanged.addListener((changes) => {
    for (const k in changes) if (k in state) state[k] = changes[k].newValue;
    apply();
  });

  // ---------- overlay ----------
  // The overlay must live inside the fullscreen element to be visible in
  // fullscreen. If the page fullscreened the <video> itself (which can't hold
  // children), use its parent instead.
  function overlayParent() {
    let p = document.fullscreenElement || document.documentElement;
    if (p.tagName === "VIDEO") p = p.parentElement || document.documentElement;
    return p;
  }
  function ensureOverlay() {
    if (overlayEl && overlayEl.isConnected) return overlayEl;
    overlayEl = document.createElement("div");
    overlayEl.id = "__subtrans_overlay";
    overlayParent().appendChild(overlayEl);
    return overlayEl;
  }

  // TEXT mode: a centered band near the bottom.
  function showText(en, original) {
    const el = ensureOverlay();
    el.className = "";
    el.style.cssText = "";
    if (!en) {
      el.style.display = "none";
      el.innerHTML = "";
      return;
    }
    el.style.display = "block";
    el.innerHTML = "";
    const d = document.createElement("div");
    d.className = "__subtrans_en";
    d.textContent = en;
    el.appendChild(d);
    if (state.showOriginal && original) {
      const o = document.createElement("div");
      o.className = "__subtrans_orig";
      o.textContent = original;
      el.appendChild(o);
    }
  }

  // OCR mode: an opaque band placed exactly over the original subtitle.
  function showCover(text, rect) {
    const el = ensureOverlay();
    el.className = "__subtrans_cover";
    if (!text) {
      el.style.display = "none";
      el.innerHTML = "";
      return;
    }
    // The band hugs the text: it expands and shrinks with the sentence length,
    // centered in the area you highlighted, and wraps within that width. Font is
    // a steady fraction of the screen (like normal subtitles), not the box size.
    const fontPx = Math.max(15, Math.min(Math.round(window.innerHeight * 0.038), 38));
    el.style.display = "inline-block";
    el.style.left = rect.left + rect.width / 2 + "px";
    el.style.top = rect.top + rect.height / 2 + "px";
    el.style.transform = "translate(-50%, -50%)";
    el.style.maxWidth = Math.round(rect.width) + "px";
    el.style.width = "auto";
    el.style.height = "auto";
    el.style.minHeight = "0";
    el.style.right = "auto";
    el.style.bottom = "auto";
    el.innerHTML = "";
    const d = document.createElement("div");
    d.className = "__subtrans_en";
    d.textContent = text;
    d.style.fontSize = fontPx + "px";
    el.appendChild(d);
  }

  document.addEventListener("fullscreenchange", () => {
    if (overlayEl) overlayParent().appendChild(overlayEl);
  });

  // ==========================================================================
  // TEXT MODE
  // ==========================================================================
  function translate(text) {
    if (cache.has(text)) return showText(cache.get(text), text);
    chrome.runtime.sendMessage(
      { type: "translate", texts: [text], source: state.source, target: state.target, backendUrl: state.backendUrl },
      (resp) => {
        if (chrome.runtime.lastError) return;
        if (resp && resp.ok && resp.translations && resp.translations[0]) {
          cache.set(text, resp.translations[0]);
          if (text === lastText) showText(resp.translations[0], text);
        }
      }
    );
  }
  function handleText(raw) {
    const text = (raw || "").replace(/\s+/g, " ").trim();
    if (text === lastText) return;
    lastText = text;
    if (!text) return showText("", "");
    translate(text);
  }
  function hookTextTracks() {
    document.querySelectorAll("video").forEach((v) => {
      const tracks = v.textTracks;
      if (!tracks) return;
      for (const tr of tracks) {
        if (tr._subtransHooked) continue;
        if (tr.kind && tr.kind !== "subtitles" && tr.kind !== "captions") continue;
        tr._subtransHooked = true;
        tr.mode = "hidden";
        tr.addEventListener("cuechange", () => {
          if (!state.enabled || state.mode !== "text") return;
          const active = tr.activeCues;
          handleText(active && active.length ? Array.from(active).map((c) => c.text).join(" ") : "");
        });
      }
    });
  }
  let domObserver = null;
  function startDomObserver() {
    if (domObserver) domObserver.disconnect();
    if (!state.selector) return;
    const read = () => {
      if (!state.enabled || state.mode !== "text") return;
      const node = document.querySelector(state.selector);
      if (!node) return;
      handleText(node.textContent);
      if (!state.showOriginal) node.style.visibility = "hidden";
    };
    domObserver = new MutationObserver(read);
    domObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    read();
  }

  // ==========================================================================
  // OCR MODE
  // ==========================================================================
  let ocrTimer = null;
  let prevHash = "";
  let sentHash = "";
  let emptyTicks = 0;
  let tainted = false; // set if the video frame can't be read into a canvas
  let selecting = false; // true while drawing the subtitle box
  let inFlight = false; // one OCR request at a time, so we never fall behind

  // Region is stored as fractions of the VIDEO element, so it tracks the video
  // at any size — including when you switch to fullscreen.
  function regionRect() {
    const r = state.ocrRegion;
    const v = largestVideo();
    if (v) {
      const vr = v.getBoundingClientRect();
      return {
        left: vr.left + r.fx * vr.width,
        top: vr.top + r.fy * vr.height,
        width: r.fw * vr.width,
        height: r.fh * vr.height,
      };
    }
    // Fallback if no video is found: treat as viewport fractions.
    return {
      left: r.fx * window.innerWidth,
      top: r.fy * window.innerHeight,
      width: r.fw * window.innerWidth,
      height: r.fh * window.innerHeight,
    };
  }

  function largestVideo() {
    let best = null, area = 0;
    document.querySelectorAll("video").forEach((v) => {
      const r = v.getBoundingClientRect();
      const a = r.width * r.height;
      if (a > area && v.videoWidth) {
        area = a;
        best = v;
      }
    });
    return best;
  }

  // Crop the region directly from the video frame. Returns a canvas, or null
  // (and flags `tainted`) if the frame can't be read.
  function grabFromVideo(rect) {
    const v = largestVideo();
    if (!v || !v.videoWidth) return null;
    const vr = v.getBoundingClientRect();
    const sx = ((rect.left - vr.left) / vr.width) * v.videoWidth;
    const sy = ((rect.top - vr.top) / vr.height) * v.videoHeight;
    const sw = (rect.width / vr.width) * v.videoWidth;
    const sh = (rect.height / vr.height) * v.videoHeight;
    if (sw < 2 || sh < 2) return null;
    const c = document.createElement("canvas");
    c.width = Math.round(sw);
    c.height = Math.round(sh);
    const ctx = c.getContext("2d");
    try {
      ctx.drawImage(v, sx, sy, sw, sh, 0, 0, c.width, c.height);
      ctx.getImageData(0, 0, 1, 1); // throws if the frame is cross-origin tainted
      return c;
    } catch (e) {
      tainted = true;
      return null;
    }
  }

  // Signature based only on BRIGHT pixels (the subtitle text), so the moving
  // video behind/around the text doesn't make every frame look "changed".
  // Nearest-neighbour downscale (smoothing off) keeps bright strokes bright.
  function fingerprint(canvas) {
    const W = 240, H = 20;
    const tc = document.createElement("canvas");
    tc.width = W;
    tc.height = H;
    const ctx = tc.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(canvas, 0, 0, W, H);
    const d = ctx.getImageData(0, 0, W, H).data;
    const cols = 60;
    const col = new Array(cols).fill(0);
    let bright = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        // White-ish = all channels high. Ignores bright COLORED background.
        if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) {
          bright++;
          col[((x * cols) / W) | 0]++;
        }
      }
    }
    let hash = "";
    for (let c = 0; c < cols; c++) hash += col[c] > 1 ? "1" : "0";
    return { hash, bright };
  }

  function processCrop(canvas, rect) {
    const fp = fingerprint(canvas);
    // Almost no bright pixels = no subtitle right now. Only clear after a
    // sustained gap so brief dips between lines don't make the English flicker.
    if (fp.bright < 12) {
      if (++emptyTicks >= 6 && sentHash !== "EMPTY") {
        sentHash = "EMPTY";
        showCover("", rect);
      }
      prevHash = fp.hash;
      return;
    }
    emptyTicks = 0;
    // A new, settled line we haven't read yet — but only if no request is in
    // flight, so a backlog can never build up and drift sentences behind. When
    // the in-flight one returns, the next tick picks up whatever is current now.
    if (fp.hash === prevHash && fp.hash !== sentHash && !inFlight) {
      sentHash = fp.hash;
      sendOcr(canvas, rect);
    }
    prevHash = fp.hash;
  }

  // Binarize the crop the same way the server does (keep near-white text as
  // black on white), so on-device Tesseract gets a clean image.
  function binarize(src) {
    const scale = src.width < 900 ? 900 / src.width : 1;
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(src.width * scale));
    c.height = Math.max(1, Math.round(src.height * scale));
    const ctx = c.getContext("2d");
    ctx.drawImage(src, 0, 0, c.width, c.height);
    const im = ctx.getImageData(0, 0, c.width, c.height);
    const d = im.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = d[i] >= 215 && d[i + 1] >= 215 && d[i + 2] >= 215 ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
    ctx.putImageData(im, 0, 0);
    return c;
  }

  function sendOcr(canvas, rect) {
    const local = state.engine === "local";
    const image = (local ? binarize(canvas) : canvas).toDataURL("image/png");
    inFlight = true;
    let done = false;
    const clear = () => { done = true; inFlight = false; };
    // The first on-device call loads the model (can take several seconds); after
    // that it's fast and warm. Server calls should never take this long.
    const safety = setTimeout(clear, local ? 15000 : 3500);
    chrome.runtime.sendMessage(
      {
        type: local ? "ocrLocal" : "ocrTranslate",
        image, source: state.source, target: state.target, lang: state.lang, backendUrl: state.backendUrl,
      },
      (resp) => {
        clearTimeout(safety);
        if (done) return; // safety already fired; this result is stale
        clear();
        if (chrome.runtime.lastError || !resp) return;
        if (!resp.ok) {
          toast(local ? "On-device OCR error (see console)" : "Server error. Check the backend URL.");
          return;
        }
        showCover(resp.translation || "", rect);
      }
    );
  }

  function captureScreenshot(rect) {
    if (overlayEl) overlayEl.style.visibility = "hidden"; // keep our band out of the shot
    chrome.runtime.sendMessage({ type: "capture" }, (resp) => {
      if (overlayEl) overlayEl.style.visibility = "visible";
      scheduleOcr();
      if (chrome.runtime.lastError || !resp || !resp.ok) return;
      const img = new Image();
      img.onload = () => {
        const scaleX = img.naturalWidth / window.innerWidth;
        const scaleY = img.naturalHeight / window.innerHeight;
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(rect.width * scaleX));
        c.height = Math.max(1, Math.round(rect.height * scaleY));
        c.getContext("2d").drawImage(
          img, Math.round(rect.left * scaleX), Math.round(rect.top * scaleY), c.width, c.height, 0, 0, c.width, c.height
        );
        processCrop(c, rect);
      };
      img.src = resp.dataUrl;
    });
  }

  function ocrTick() {
    if (!isTop || !state.enabled || state.mode !== "ocr") return;
    if (selecting) return scheduleOcr(); // paused while picking the box
    if (document.hidden || !state.ocrRegion) return scheduleOcr();
    if (state.engine !== "local" && !state.backendUrl) return scheduleOcr();
    const rect = regionRect();
    if (!tainted) {
      const c = grabFromVideo(rect);
      if (c) {
        processCrop(c, rect);
        return scheduleOcr();
      }
    }
    captureScreenshot(rect); // fallback (schedules itself)
  }

  function scheduleOcr() {
    clearTimeout(ocrTimer);
    // Fast path (reading the video frame) is cheap and local, so poll often.
    // Screenshot fallback is rate-limited by Chrome (~2/s), so ease off there.
    if (isTop && state.enabled && state.mode === "ocr") {
      ocrTimer = setTimeout(ocrTick, tainted ? 520 : 220);
    }
  }

  // ==========================================================================
  // lifecycle
  // ==========================================================================
  let pollTimer = null;
  function apply() {
    clearTimeout(ocrTimer);
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }
    prevHash = sentHash = "";
    emptyTicks = 0;
    inFlight = false;
    lastText = "";

    if (!state.enabled) {
      if (overlayEl) {
        overlayEl.style.display = "none";
        overlayEl.innerHTML = "";
      }
      return;
    }
    if (state.mode === "text") {
      showText("", "");
      hookTextTracks();
      pollTimer = setInterval(hookTextTracks, 2000);
      startDomObserver();
    } else {
      if (overlayEl) overlayEl.style.display = "none";
      scheduleOcr();
    }
  }

  // ==========================================================================
  // pickers
  // ==========================================================================
  let hoverEl = null;
  function startTeaching() {
    document.addEventListener("mouseover", onHover, true);
    document.addEventListener("click", onPick, true);
    toast("Play the video, then click the subtitle text once.");
  }
  function onHover(e) {
    if (hoverEl) hoverEl.style.outline = "";
    hoverEl = e.target;
    hoverEl.style.outline = "2px solid #4f8cff";
  }
  function onPick(e) {
    e.preventDefault();
    e.stopPropagation();
    document.removeEventListener("mouseover", onHover, true);
    document.removeEventListener("click", onPick, true);
    if (hoverEl) hoverEl.style.outline = "";
    chrome.storage.sync.set({ selector: cssPath(e.target), mode: "text", enabled: true });
    toast("Locked on. Translating from here.");
  }
  function cssPath(el) {
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 5) {
      if (el.id) {
        parts.unshift("#" + CSS.escape(el.id));
        break;
      }
      let part = el.tagName.toLowerCase();
      if (typeof el.className === "string" && el.className.trim()) {
        part += el.className.trim().split(/\s+/).slice(0, 2).map((c) => "." + CSS.escape(c)).join("");
      }
      parts.unshift(part);
      el = el.parentElement;
    }
    return parts.join(" > ");
  }

  function startRegionSelect() {
    // Pause OCR and hide the band so it doesn't sit in the way while picking.
    selecting = true;
    if (overlayEl) {
      overlayEl.style.display = "none";
      overlayEl.innerHTML = "";
    }
    const layer = document.createElement("div");
    layer.id = "__subtrans_select";
    const box = document.createElement("div");
    box.id = "__subtrans_selbox";
    layer.appendChild(box);
    // Show where the box currently sits, so you can see / adjust it.
    if (state.ocrRegion) {
      const cur = regionRect();
      const guide = document.createElement("div");
      guide.id = "__subtrans_curbox";
      guide.style.left = cur.left + "px";
      guide.style.top = cur.top + "px";
      guide.style.width = cur.width + "px";
      guide.style.height = cur.height + "px";
      guide.textContent = "current box";
      layer.appendChild(guide);
    }
    document.documentElement.appendChild(layer);
    toast("Drag a new box over the Hebrew. Esc = cancel · Delete = erase box.");

    let sx = 0, sy = 0, dragging = false;
    const place = (x, y) => {
      box.style.left = Math.min(sx, x) + "px";
      box.style.top = Math.min(sy, y) + "px";
      box.style.width = Math.abs(x - sx) + "px";
      box.style.height = Math.abs(y - sy) + "px";
    };
    const onDown = (e) => {
      dragging = true;
      sx = e.clientX;
      sy = e.clientY;
      box.style.display = "block";
      place(e.clientX, e.clientY);
    };
    const onMove = (e) => dragging && place(e.clientX, e.clientY);
    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;
      const left = Math.min(sx, e.clientX), top = Math.min(sy, e.clientY);
      const w = Math.abs(e.clientX - sx), h = Math.abs(e.clientY - sy);
      cleanup();
      if (w < 12 || h < 8) return toast("That box was too small — try again.");
      const v = largestVideo();
      let region;
      if (v) {
        const vr = v.getBoundingClientRect();
        region = {
          fx: (left - vr.left) / vr.width,
          fy: (top - vr.top) / vr.height,
          fw: w / vr.width,
          fh: h / vr.height,
        };
      } else {
        region = {
          fx: left / window.innerWidth,
          fy: top / window.innerHeight,
          fw: w / window.innerWidth,
          fh: h / window.innerHeight,
        };
      }
      chrome.storage.sync.set({ ocrRegion: region, mode: "ocr", enabled: true });
      toast("Subtitle area set. Translating…");
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        cleanup();
        toast("Cancelled.");
      } else if (e.key === "Delete" || e.key === "Backspace") {
        cleanup();
        chrome.storage.sync.set({ ocrRegion: null });
        toast("Subtitle box erased.");
      }
    };
    function cleanup() {
      selecting = false;
      prevHash = sentHash = ""; // re-detect the current line right away
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
      window.removeEventListener("keydown", onKey, true);
      layer.remove();
      scheduleOcr();
    }
    layer.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
    window.addEventListener("keydown", onKey, true);
  }

  function toast(msg) {
    let t = document.getElementById("__subtrans_toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "__subtrans_toast";
      document.documentElement.appendChild(t);
    }
    t.textContent = msg;
    t.style.display = "block";
    clearTimeout(t._timer);
    t._timer = setTimeout(() => (t.style.display = "none"), 4000);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "startTeaching") startTeaching();
    if (msg.type === "startRegionSelect" && isTop) startRegionSelect();
    if (msg.type === "clearSelector") {
      chrome.storage.sync.set({ selector: null, ocrRegion: null });
      if (overlayEl) {
        overlayEl.style.display = "none";
        overlayEl.innerHTML = "";
      }
      sentHash = "";
      toast("Subtitle box erased.");
    }
  });

  loadSettings();
})();
