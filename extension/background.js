// Service worker: handles all network/privileged calls for the content script.
//   translate     — text → translated text (backend, or Google fallback)
//   ocrTranslate  — image → recognized + translated text (backend only)
//   capture       — screenshot the visible tab (for OCR cropping)

async function translateViaBackend(backendUrl, texts, source, target) {
  const res = await fetch(backendUrl.replace(/\/+$/, "") + "/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts, source, target }),
  });
  if (!res.ok) throw new Error("backend HTTP " + res.status);
  return (await res.json()).translations;
}

// Fallback for TEXT mode only: Google's public endpoint, one request per line.
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
          body: JSON.stringify({
            image: msg.image, source: msg.source, target: msg.target, lang: msg.lang,
          }),
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
