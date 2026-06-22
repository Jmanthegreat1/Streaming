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
function fixLeadingPunct(s) {
  const m = /^\s*([?!.]+)\s*(.+)$/.exec(s);
  return m ? m[2].replace(/\s+$/, "") + m[1] : s;
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
  const hebCount = (text.match(/[א-ת]/g) || []).length;
  return hebCount < 2 ? "" : text; // reject noise so it can't become random words
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
        sendResponse({ ok: true, text, translation: fixLeadingPunct(translations[0] || "") });
      } catch (e) {
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
