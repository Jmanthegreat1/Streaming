// Service worker: network + privileged work for the content script.
//   translate     — text → translated text (server, or Google fallback)
//   ocrTranslate  — image → recognized + translated text (SERVER OCR)
//   ocrLocal      — image → recognized + translated text (ON-DEVICE OCR via
//                   the offscreen document running Tesseract; translation still
//                   uses Google, but only a tiny text request — no image upload)
//   capture       — screenshot the visible tab (for OCR cropping)

// ---------- translation ----------
async function translateViaBackend(backendUrl, texts, source, target) {
  const res = await fetch(backendUrl.replace(/\/+$/, "") + "/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts, source, target }),
  });
  if (!res.ok) throw new Error("backend HTTP " + res.status);
  return (await res.json()).translations;
}

async function translateViaGoogle(texts, source, target) {
  const out = [];
  for (const q of texts) {
    try {
      const url =
        "https://translate.googleapis.com/translate_a/single?client=gtx" +
        "&sl=" + encodeURIComponent(source || "auto") +
        "&tl=" + encodeURIComponent(target) +
        "&dt=t&q=" + encodeURIComponent(q);
      const j = await (await fetch(url)).json();
      out.push(j[0].map((seg) => seg[0]).join(""));
    } catch (e) {
      out.push(q);
    }
  }
  return out;
}

// ---------- Google Cloud Vision OCR (accurate, fast; needs the user's key) ----------
async function visionOcr(apiKey, dataUrl) {
  const b64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
  const res = await fetch("https://vision.googleapis.com/v1/images:annotate?key=" + encodeURIComponent(apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [{
        image: { content: b64 },
        features: [{ type: "TEXT_DETECTION" }],
        imageContext: { languageHints: ["he"] },
      }],
    }),
  });
  const data = await res.json();
  const r = data.responses && data.responses[0];
  if (r && r.error) throw new Error(r.error.message || "Vision error");
  if (!res.ok) throw new Error("Vision HTTP " + res.status);
  return (r && ((r.fullTextAnnotation && r.fullTextAnnotation.text) ||
    (r.textAnnotations && r.textAnnotations[0] && r.textAnnotations[0].description))) || "";
}

// ---------- Hebrew OCR text cleanup (mirrors the server) ----------
// Normalize sentence punctuation in one segment: pick the end mark (? > ! > .)
// from whatever terminal punctuation is present, strip ALL misplaced marks
// (the RTL artifact can put them anywhere), and re-attach one at the end.
// Decimal points (5.5) are protected. Clean segments are left untouched.
function fixSegmentPunct(seg) {
  const t = (seg || "").trim();
  if (!t) return "";
  const inner = t.slice(0, -1);
  if (!/[?!]/.test(inner) && !/(?<!\d)\.(?!\d)/.test(inner)) return t; // already clean
  const end = /\?/.test(t) ? "?" : /!/.test(t) ? "!" : /(?<!\d)\.(?!\d)/.test(t) ? "." : "";
  const body = t
    .replace(/[?!]+/g, " ")
    .replace(/(?<!\d)\.+(?!\d)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return body ? body + end : t;
}

// Reorder punctuation across a line, handling each dialogue segment (split on " - ").
function reorderPunct(s) {
  s = s.replace(/^\s*\.\s*(?=[-–—])/, ""); // stray period before a leading dash
  return s
    .split(/(\s*[-–—]\s+)/)
    .map((seg) => (/^\s*[-–—]\s+$/.test(seg) ? seg : fixSegmentPunct(seg)))
    .join("")
    .trim();
}

function cleanHebrew(raw) {
  if (!raw) return "";
  let text = raw.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join(" ");
  // Keep only letters / digits / basic punctuation — drops junk symbols wholesale.
  text = text.replace(/[^A-Za-zא-ת0-9\s.,?!'"%:;\-]/g, " ");
  text = text.replace(/(^|\s)[-–—.]{2,}(?=\s|$)/g, " "); // runs like --- or ..
  text = text.replace(/(^|\s)\.(?=\s|$)/g, " "); // standalone dot
  text = text.replace(/\s+/g, " ").trim();
  // Fix Hebrew punctuation before translating so Google gets it right.
  text = reorderPunct(text);
  // A real subtitle has an actual Hebrew WORD (3+ letters in a row), or several
  // Hebrew letters, and Hebrew dominates. Rejects "ל 8 מ"-style scene-noise junk.
  const heb = (text.match(/[א-ת]/g) || []).length;
  const alnum = (text.match(/[א-ת0-9A-Za-z]/g) || []).length;
  const hasWord = /[א-ת]{3,}/.test(text);
  return (!hasWord && heb < 4) || heb < alnum * 0.55 ? "" : text;
}

// ---------- offscreen document (hosts Tesseract) ----------
let creating = null;
async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (ctx.length) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS"],
      justification: "Run on-device OCR (Tesseract) for live subtitle translation.",
    });
  }
  await creating;
  creating = null;
}

// ---------- messages ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "translate") {
    (async () => {
      try {
        const translations = msg.backendUrl
          ? await translateViaBackend(msg.backendUrl, msg.texts, msg.source, msg.target)
          : await translateViaGoogle(msg.texts, msg.source, msg.target);
        sendResponse({ ok: true, translations });
      } catch (e) {
        try {
          sendResponse({ ok: true, fallback: true,
            translations: await translateViaGoogle(msg.texts, msg.source, msg.target) });
        } catch (e2) {
          sendResponse({ ok: false, error: String(e2) });
        }
      }
    })();
    return true;
  }

  if (msg.type === "ocrTranslate") {
    (async () => {
      try {
        if (!msg.backendUrl) throw new Error("no backend URL set");
        const res = await fetch(msg.backendUrl.replace(/\/+$/, "") + "/ocr-translate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: msg.image, source: msg.source, target: msg.target, lang: msg.lang }),
        });
        if (!res.ok) throw new Error("backend HTTP " + res.status);
        const data = await res.json();
        sendResponse({ ok: true, text: data.text, translation: data.translation });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  if (msg.type === "ocrLocal") {
    (async () => {
      try {
        await ensureOffscreen();
        const ocr = await chrome.runtime.sendMessage({ target: "offscreen", type: "ocr", image: msg.image });
        if (!ocr || !ocr.ok) throw new Error((ocr && ocr.error) || "on-device OCR failed");
        const text = cleanHebrew(ocr.text);
        if (!text) {
          sendResponse({ ok: true, text: "", translation: "" });
          return;
        }
        const translations = await translateViaGoogle([text], msg.source || "auto", msg.target || "en");
        sendResponse({ ok: true, text, translation: reorderPunct(translations[0] || "") });
      } catch (e) {
        console.warn("on-device OCR failed:", e); // visible in the service-worker console
        // Fall back to the server so subtitles still appear while we fix local.
        if (msg.backendUrl) {
          try {
            const res = await fetch(msg.backendUrl.replace(/\/+$/, "") + "/ocr-translate", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ image: msg.image, source: msg.source, target: msg.target, lang: msg.lang }),
            });
            if (res.ok) {
              const data = await res.json();
              sendResponse({ ok: true, text: data.text, translation: data.translation, fallback: true });
              return;
            }
          } catch (e2) {
            /* fall through to error */
          }
        }
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }

  if (msg.type === "ocrVision") {
    (async () => {
      try {
        if (!msg.visionKey) throw new Error("no Vision API key set");
        const raw = await visionOcr(msg.visionKey, msg.image);
        const text = cleanHebrew(raw);
        if (!text) {
          sendResponse({ ok: true, text: "", translation: "" });
          return;
        }
        const translations = await translateViaGoogle([text], "iw", msg.target || "en");
        sendResponse({ ok: true, text, translation: reorderPunct(translations[0] || "") });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }

  if (msg.type === "prewarm") {
    // Spin up the offscreen doc (which starts loading the model) before the
    // first subtitle, so the first line isn't delayed by a cold model load.
    ensureOffscreen().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === "capture") {
    const windowId = sender.tab ? sender.tab.windowId : chrome.windows.WINDOW_ID_CURRENT;
    chrome.tabs.captureVisibleTab(windowId, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError || !dataUrl) {
        sendResponse({ ok: false, error: chrome.runtime.lastError && chrome.runtime.lastError.message });
      } else {
        sendResponse({ ok: true, dataUrl });
      }
    });
    return true;
  }
});
