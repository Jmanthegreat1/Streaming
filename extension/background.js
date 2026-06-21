// Service worker: does the actual translation network calls.
// Content scripts can't make cross-origin requests freely, but the service
// worker can (host_permissions covers all hosts), so all translation is routed
// here via messages.

async function translateViaBackend(backendUrl, texts, source, target) {
  const url = backendUrl.replace(/\/+$/, "") + "/translate";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts, source, target }),
  });
  if (!res.ok) throw new Error("backend HTTP " + res.status);
  const data = await res.json();
  return data.translations;
}

// Fallback: Google's public translate endpoint, one request per line.
// Used when no backend URL is set, or the backend is unreachable.
async function translateViaGoogle(texts, source, target) {
  const out = [];
  for (const q of texts) {
    try {
      const url =
        "https://translate.googleapis.com/translate_a/single?client=gtx" +
        "&sl=" + encodeURIComponent(source || "auto") +
        "&tl=" + encodeURIComponent(target) +
        "&dt=t&q=" + encodeURIComponent(q);
      const r = await fetch(url);
      const j = await r.json();
      out.push(j[0].map((seg) => seg[0]).join(""));
    } catch (e) {
      out.push(q);
    }
  }
  return out;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "translate") return;

  (async () => {
    try {
      let translations;
      if (msg.backendUrl) {
        translations = await translateViaBackend(
          msg.backendUrl, msg.texts, msg.source, msg.target
        );
      } else {
        translations = await translateViaGoogle(msg.texts, msg.source, msg.target);
      }
      sendResponse({ ok: true, translations });
    } catch (e) {
      // Backend failed — try the public endpoint before giving up.
      try {
        const translations = await translateViaGoogle(
          msg.texts, msg.source, msg.target
        );
        sendResponse({ ok: true, translations, fallback: true });
      } catch (e2) {
        sendResponse({ ok: false, error: String(e2) });
      }
    }
  })();

  return true; // keep the message channel open for the async response
});
