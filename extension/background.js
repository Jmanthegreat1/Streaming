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
      out.push(decodeEntities(j[0].map((seg) => seg[0]).join("")));
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
// The one end mark a punctuation cluster stands for: ... > ? > ! > . ;
// comma/colon-only clusters stand for nothing.
function endMark(cluster) {
  if (/^\.{2,}$/.test(cluster)) return "...";
  if (cluster.includes("?")) return "?";
  if (cluster.includes("!")) return "!";
  if (cluster.includes(".")) return ".";
  return "";
}

// Undo the RTL scramble in one OCR'd segment: marks glued to the FRONT of the
// line (or of a following word) belong at the end of the word before.
// Interior punctuation is left exactly where it is.
function descrambleHebSegment(seg) {
  let t = (seg || "").trim();
  if (!t) return "";
  // A word's end-mark drifted onto the next word ("שלום ?מה") or floats at
  // the end. Dots are not touched here (decimal / ellipsis ambiguity).
  t = t.replace(/(\S)\s+([?!]+)(?=\S)/g, "$1$2 ");
  t = t.replace(/(\S)\s+([?!]+)$/, "$1$2");
  const m = t.match(/^([?!.,:;]+)\s*([\s\S]*)$/);
  if (m) {
    const rest = m[2].trim();
    if (!rest) return ""; // a lone mark is noise, not a subtitle
    t = /[?!.]$/.test(rest) ? rest : rest + endMark(m[1]);
  }
  return t.replace(/\s+/g, " ").trim();
}

// Fix the RTL punctuation scramble across a line, per dialogue segment (split on " - ").
function descrambleHebPunct(s) {
  s = s.replace(/^\s*\.\s*(?=[-–—])/, ""); // stray period before a leading dash
  return s
    .split(/(\s*[-–—]\s+)/)
    .map((seg) => (/^\s*[-–—]\s+$/.test(seg) ? seg : descrambleHebSegment(seg)))
    .join("")
    .trim();
}

// The free translate endpoints return HTML entities (&#39; for ').
function decodeEntities(s) {
  s = s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, " ")
    .replace(/&gt;/g, " ")
    .replace(/&amp;/g, "&");
  const chr = (n) => (n >= 32 && n < 0x110000 ? String.fromCodePoint(n) : " ");
  s = s.replace(/&#(\d+);/g, (_, d) => chr(parseInt(d, 10)));
  s = s.replace(/&#[xX]([0-9A-Fa-f]+);/g, (_, h) => chr(parseInt(h, 16)));
  return s;
}

// Tidy the translated line WITHOUT restructuring it: decode HTML entities,
// drop junk symbols, move a leading mark cluster to the end where it belongs,
// fix spacing around marks, collapse repeats. Interior punctuation that the
// translator produced ("What? Let's go.") is never rearranged.
function finalizeEnglish(s) {
  s = decodeEntities(s || "");
  s = s.replace(/[<>#*|~=^_{}\[\]\\/@`\x00-\x1f\x7f]/g, " ").trim();
  const m = s.match(/^([?!.,:;]+)\s*([\s\S]*)$/);
  if (m && !/^\.{2,}$/.test(m[1])) { // a leading "..." is a real continuation
    s = m[2].trim();
    if (s && !/[?!.]$/.test(s)) s += endMark(m[1]);
  }
  s = s.replace(/\s+([,.;:?!])/g, "$1"); // "Yes , no ." → "Yes, no."
  s = s.replace(/([,;:?!])(?=\p{L})/gu, "$1 "); // mark glued to the next word
  s = s.replace(/\?{2,}/g, "?").replace(/!{2,}/g, "!").replace(/,{2,}/g, ",");
  s = s.replace(/\.{4,}/g, "...").replace(/(?<!\.)\.\.(?!\.)/g, "."); // ".." typo; "..." kept
  s = s.replace(/\s+/g, " ").trim();
  return /[\p{L}\p{N}]/u.test(s) ? s : "";
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
  text = descrambleHebPunct(text);
  // A real subtitle has an actual Hebrew WORD (3+ letters in a row), several
  // Hebrew letters, or is a single compact word (כן / לא / מה?), and Hebrew
  // dominates. Rejects "ל 8 מ"-style scene-noise junk.
  const heb = (text.match(/[א-ת]/g) || []).length;
  const alnum = (text.match(/[א-ת0-9A-Za-z]/g) || []).length;
  const hasWord = /[א-ת]{3,}/.test(text);
  if (/^[א-ת]{2,3}[?!.]?$/.test(text)) return text;
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
        sendResponse({ ok: true, text, translation: finalizeEnglish(translations[0] || "") });
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
        sendResponse({ ok: true, text, translation: finalizeEnglish(translations[0] || "") });
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
