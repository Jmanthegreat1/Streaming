// Runs on every page. Two ways to get subtitles:
//   TEXT mode — read native <track> cues or a DOM element you click.
//   OCR  mode — screenshot a region you draw over burned-in subtitles, send it
//               to the backend to read + translate, and overlay the English.
// The OCR overlay is drawn just ABOVE the captured region so it never feeds
// back into the screenshot (and because burned-in Hebrew can't be removed).

(() => {
  const DEFAULTS = {
    enabled: false,
    mode: "ocr", // "ocr" | "text"
    target: "en",
    source: "auto",
    lang: "heb", // OCR language
    backendUrl: "",
    showOriginal: false,
    selector: null, // taught element (text mode)
    ocrRegion: null, // {fx, fy, fw, fh} fractions of the video rect
  };
  const state = { ...DEFAULTS };
  const isTop = window === window.top; // OCR (capture + region) runs top-frame only

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
  function ensureOverlay() {
    if (overlayEl && overlayEl.isConnected) return overlayEl;
    overlayEl = document.createElement("div");
    overlayEl.id = "__subtrans_overlay";
    (document.fullscreenElement || document.documentElement).appendChild(overlayEl);
    return overlayEl;
  }

  function showText(en, original, bottomPx) {
    const el = ensureOverlay();
    if (!en) {
      el.style.display = "none";
      el.innerHTML = "";
      return;
    }
    el.style.display = "block";
    el.style.bottom = bottomPx == null ? "" : bottomPx + "px";
    el.innerHTML = "";
    const enDiv = document.createElement("div");
    enDiv.className = "__subtrans_en";
    enDiv.textContent = en;
    el.appendChild(enDiv);
    if (state.showOriginal && original) {
      const o = document.createElement("div");
      o.className = "__subtrans_orig";
      o.textContent = original;
      el.appendChild(o);
    }
  }

  document.addEventListener("fullscreenchange", () => {
    if (overlayEl) {
      (document.fullscreenElement || document.documentElement).appendChild(overlayEl);
    }
  });

  // ==========================================================================
  // TEXT MODE
  // ==========================================================================
  function translate(text) {
    if (cache.has(text)) {
      showText(cache.get(text), text);
      return;
    }
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

  // Region is stored as fractions of the (top) viewport, so it maps directly
  // onto the full-tab screenshot. Selecting while fullscreen (as on a TV) keeps
  // it aligned with the video.
  function regionRect() {
    const r = state.ocrRegion;
    return {
      left: r.fx * window.innerWidth,
      top: r.fy * window.innerHeight,
      width: r.fw * window.innerWidth,
      height: r.fh * window.innerHeight,
    };
  }

  function fingerprint(srcCanvas) {
    const tc = document.createElement("canvas");
    tc.width = 28;
    tc.height = 6;
    const ctx = tc.getContext("2d");
    ctx.drawImage(srcCanvas, 0, 0, 28, 6);
    const d = ctx.getImageData(0, 0, 28, 6).data;
    let hash = "", min = 255, max = 0;
    for (let i = 0; i < d.length; i += 4) {
      const lum = (d[i] + d[i + 1] + d[i + 2]) / 3;
      hash += lum > 128 ? "1" : "0";
      if (lum < min) min = lum;
      if (lum > max) max = lum;
    }
    return { hash, variance: max - min };
  }

  function ocrTick() {
    if (!isTop || !state.enabled || state.mode !== "ocr") return;
    if (document.hidden || !state.ocrRegion || !state.backendUrl) return scheduleOcr();

    const rect = regionRect();

    chrome.runtime.sendMessage({ type: "capture" }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) return scheduleOcr();
      const img = new Image();
      img.onload = () => {
        processFrame(img, rect);
        scheduleOcr();
      };
      img.onerror = scheduleOcr;
      img.src = resp.dataUrl;
    });
  }

  function processFrame(img, rect) {
    const scaleX = img.naturalWidth / window.innerWidth;
    const scaleY = img.naturalHeight / window.innerHeight;
    const sw = Math.max(1, Math.round(rect.width * scaleX));
    const sh = Math.max(1, Math.round(rect.height * scaleY));
    const sx = Math.max(0, Math.round(rect.left * scaleX));
    const sy = Math.max(0, Math.round(rect.top * scaleY));

    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    canvas.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

    const fp = fingerprint(canvas);

    // Near-uniform region = no subtitle on screen right now.
    if (fp.variance < 28) {
      if (sentHash !== "EMPTY") {
        sentHash = "EMPTY";
        showText("", "");
      }
      prevHash = fp.hash;
      return;
    }

    // Fire OCR only once the region has been stable for two ticks (avoids
    // catching a subtitle mid-fade) and we haven't already read this frame.
    if (fp.hash === prevHash && fp.hash !== sentHash) {
      sentHash = fp.hash;
      sendOcr(canvas.toDataURL("image/png"), rect);
    }
    prevHash = fp.hash;
  }

  function sendOcr(dataUrl, rect) {
    chrome.runtime.sendMessage(
      {
        type: "ocrTranslate",
        image: dataUrl,
        source: state.source,
        target: state.target,
        lang: state.lang,
        backendUrl: state.backendUrl,
      },
      (resp) => {
        if (chrome.runtime.lastError || !resp) return;
        if (!resp.ok) {
          toast("Translation server error. Check the backend URL.");
          return;
        }
        const bottom = Math.max(8, window.innerHeight - rect.top + 10);
        showText(resp.translation || "", resp.text || "", bottom);
      }
    );
  }

  function scheduleOcr() {
    clearTimeout(ocrTimer);
    if (isTop && state.enabled && state.mode === "ocr") ocrTimer = setTimeout(ocrTick, 800);
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
    lastText = "";

    if (!state.enabled) {
      showText("", "");
      return;
    }

    if (state.mode === "text") {
      hookTextTracks();
      pollTimer = setInterval(hookTextTracks, 2000);
      startDomObserver();
    } else {
      showText("", "");
      scheduleOcr();
    }
  }

  // ==========================================================================
  // pickers (text element / OCR region)
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

  // OCR region: drag a rectangle over the burned-in subtitles.
  function startRegionSelect() {
    const layer = document.createElement("div");
    layer.id = "__subtrans_select";
    const box = document.createElement("div");
    box.id = "__subtrans_selbox";
    layer.appendChild(box);
    document.documentElement.appendChild(layer);
    toast("Drag a box over the Hebrew subtitles. Esc to cancel.");

    let sx = 0, sy = 0, dragging = false;
    const onDown = (e) => {
      dragging = true;
      sx = e.clientX;
      sy = e.clientY;
      box.style.display = "block";
      place(e.clientX, e.clientY);
    };
    const place = (x, y) => {
      box.style.left = Math.min(sx, x) + "px";
      box.style.top = Math.min(sy, y) + "px";
      box.style.width = Math.abs(x - sx) + "px";
      box.style.height = Math.abs(y - sy) + "px";
    };
    const onMove = (e) => dragging && place(e.clientX, e.clientY);
    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;
      const left = Math.min(sx, e.clientX), top = Math.min(sy, e.clientY);
      const w = Math.abs(e.clientX - sx), h = Math.abs(e.clientY - sy);
      cleanup();
      if (w < 12 || h < 8) return toast("That box was too small — try again.");
      const region = {
        fx: left / window.innerWidth,
        fy: top / window.innerHeight,
        fw: w / window.innerWidth,
        fh: h / window.innerHeight,
      };
      chrome.storage.sync.set({ ocrRegion: region, mode: "ocr", enabled: true });
      toast("Subtitle area set. Translating…");
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        cleanup();
        toast("Cancelled.");
      }
    };
    function cleanup() {
      layer.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
      window.removeEventListener("keydown", onKey, true);
      layer.remove();
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
    if (msg.type === "clearSelector") chrome.storage.sync.set({ selector: null, ocrRegion: null });
  });

  loadSettings();
})();
