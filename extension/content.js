// Runs on every page. Finds the current subtitle text two ways:
//   1. Native <track> cues on a <video> (the clean path).
//   2. A DOM element you "teach" it by clicking (fallback for custom players).
// Then translates the text and draws it as an overlay at the bottom of the screen.

(() => {
  const DEFAULTS = {
    enabled: false,
    target: "en",
    source: "auto",
    backendUrl: "",
    showOriginal: false,
    selector: null, // CSS selector taught via the picker
  };
  const state = { ...DEFAULTS };

  let overlayEl = null;
  let lastText = "";
  const cache = new Map();

  // ---------- settings ----------
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

  function showText(en, original) {
    const el = ensureOverlay();
    if (!en) {
      el.style.display = "none";
      el.innerHTML = "";
      return;
    }
    el.style.display = "block";
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

  // Keep the overlay inside the fullscreen element (otherwise it's invisible
  // while the video is fullscreen — important for watching on a TV via HDMI).
  document.addEventListener("fullscreenchange", () => {
    if (!overlayEl) return;
    (document.fullscreenElement || document.documentElement).appendChild(overlayEl);
  });

  // ---------- translation ----------
  function translate(text) {
    if (cache.has(text)) {
      showText(cache.get(text), text);
      return;
    }
    chrome.runtime.sendMessage(
      {
        type: "translate",
        texts: [text],
        source: state.source,
        target: state.target,
        backendUrl: state.backendUrl,
      },
      (resp) => {
        if (chrome.runtime.lastError) return;
        if (resp && resp.ok && resp.translations && resp.translations[0]) {
          const en = resp.translations[0];
          cache.set(text, en);
          if (text === lastText) showText(en, text); // still the current line?
        }
      }
    );
  }

  function handleText(raw) {
    const text = (raw || "").replace(/\s+/g, " ").trim();
    if (text === lastText) return;
    lastText = text;
    if (!text) {
      showText("", "");
      return;
    }
    translate(text);
  }

  // ---------- strategy 1: native text tracks ----------
  function hookTextTracks() {
    document.querySelectorAll("video").forEach((v) => {
      const tracks = v.textTracks;
      if (!tracks) return;
      for (const tr of tracks) {
        if (tr._subtransHooked) continue;
        if (tr.kind && tr.kind !== "subtitles" && tr.kind !== "captions") continue;
        tr._subtransHooked = true;
        tr._origMode = tr.mode;
        // "hidden" still fires cuechange and parses cues, but stops the browser
        // from drawing the original — we draw our own translated overlay.
        tr.mode = state.showOriginal ? "hidden" : "hidden";
        tr.addEventListener("cuechange", () => {
          if (!state.enabled) return;
          const active = tr.activeCues;
          if (active && active.length) {
            handleText(Array.from(active).map((c) => c.text).join(" "));
          } else {
            handleText("");
          }
        });
      }
    });
  }

  // ---------- strategy 2: taught DOM element ----------
  let domObserver = null;
  function startDomObserver() {
    if (domObserver) domObserver.disconnect();
    if (!state.selector) return;
    const read = () => {
      if (!state.enabled) return;
      const node = document.querySelector(state.selector);
      if (!node) return;
      handleText(node.textContent);
      if (!state.showOriginal) node.style.visibility = "hidden";
    };
    domObserver = new MutationObserver(read);
    domObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    read();
  }

  // ---------- lifecycle ----------
  let pollTimer = null;
  function apply() {
    if (state.enabled) {
      hookTextTracks();
      if (!pollTimer) pollTimer = setInterval(hookTextTracks, 2000);
      startDomObserver();
    } else {
      showText("", "");
      lastText = "";
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (domObserver) {
        domObserver.disconnect();
        domObserver = null;
      }
    }
  }

  // ---------- teaching mode ----------
  let teaching = false;
  let hoverEl = null;

  function startTeaching() {
    if (teaching) return;
    teaching = true;
    document.addEventListener("mouseover", onHover, true);
    document.addEventListener("click", onPick, true);
    toast("Play the video, then click the Hebrew subtitle text once.");
  }
  function stopTeaching() {
    teaching = false;
    document.removeEventListener("mouseover", onHover, true);
    document.removeEventListener("click", onPick, true);
    if (hoverEl) {
      hoverEl.style.outline = "";
      hoverEl = null;
    }
  }
  function onHover(e) {
    if (hoverEl) hoverEl.style.outline = "";
    hoverEl = e.target;
    hoverEl.style.outline = "2px solid #4f8cff";
  }
  function onPick(e) {
    e.preventDefault();
    e.stopPropagation();
    const sel = cssPath(e.target);
    chrome.storage.sync.set({ selector: sel, enabled: true });
    stopTeaching();
    toast("Locked on. Translating from here.");
  }

  // Build a reasonably stable selector, preferring id/classes.
  function cssPath(el) {
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 5) {
      if (el.id) {
        parts.unshift("#" + CSS.escape(el.id));
        break;
      }
      let part = el.tagName.toLowerCase();
      if (typeof el.className === "string" && el.className.trim()) {
        part += el.className
          .trim()
          .split(/\s+/)
          .slice(0, 2)
          .map((c) => "." + CSS.escape(c))
          .join("");
      }
      parts.unshift(part);
      el = el.parentElement;
    }
    return parts.join(" > ");
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

  // Messages from the popup.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "startTeaching") startTeaching();
    if (msg.type === "clearSelector") {
      chrome.storage.sync.set({ selector: null });
      toast("Cleared. Using automatic detection.");
    }
  });

  loadSettings();
})();
