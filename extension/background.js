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

// ---------- Hebrew OCR text cleanup (mirrors the server) ----------
// Move a run of leading sentence punctuation (. ? !) to the end of the segment
// (the RTL artifact), without doubling up if it already ends with punctuation.
function fixLeadingPunct(s) {
  s = s.replace(/^\s*\.\s*(?=[-–—])/, ""); // stray period right before a dialogue dash
  const m = /^\s*([?!.]+)\s*(.+?)\s*$/.exec(s);
  if (!m) return s;
  return m[2].replace(/[?!.]+$/, "") + m[1];
}

// Reorder punctuation across a whole line: handle each dialogue segment
// (split on " - ") on its own, so multi-speaker lines come out right.
function reorderPunct(s) {
  s = s.replace(/^\s*\.\s*(?=[-–—])/, ""); // stray period before a leading dash
  return s
    .split(/(\s*[-–—]\s+)/)
    .map((seg) => (/^\s*[-–—]\s+$/.test(seg) ? seg : fixLeadingPunct(seg)))
    .join("")
    .trim();
}

function cleanHebrew(raw) {
  if (!raw) return "";
  const lines = raw
    .split(/\r?\n/)
    .map((l) => fixLeadingPunct(l.replace(/\s+/g, " ").trim()))
    .filter(Boolean);
  let text = lines.join(" ");
  text = text.replace(/(^|\s)[|_~`^*¦•·=]+(?=\s|$)/g, " ");
  text = text.replace(/(^|\s)[.]{1,2}(?=\s|$)/g, " ");
  text = text.replace(/\s+/g, " ").trim().replace(/^[|_~`^*¦•·=]+|[|_~`^*¦•·=]+$/g, "").trim();
  text = fixLeadingPunct(text);
  // Reject noise (white shirt stripes, clocks, numbers): need a couple of Hebrew
  // letters AND Hebrew must dominate over digits/latin, or it's not a subtitle.
  const heb = (text.match(/[א-ת]/g) || []).length;
  const alnum = (text.match(/[א-ת0-9A-Za-z]/g) || []).length;
  return heb < 2 || heb < alnum * 0.6 ? "" : text;
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
        if (ocr && ocr.busy) {
          sendResponse({ ok: true, skip: true }); // worker still busy — keep current line
          return;
        }
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
