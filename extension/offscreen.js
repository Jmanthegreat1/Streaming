// Runs in the offscreen document (an extension page), where we're allowed to
// spin up the Tesseract web worker + WASM. It keeps one warm Hebrew worker and
// recognizes images on request from the service worker.

let workerPromise = null;

function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await Tesseract.createWorker("heb", 1, {
        workerPath: chrome.runtime.getURL("tesseract/worker.min.js"),
        // Point at the exact bundled core so Tesseract can't request a variant
        // filename we didn't ship (a common cause of OCR failing in extensions).
        corePath: chrome.runtime.getURL("tesseract/tesseract-core-simd.wasm.js"),
        langPath: chrome.runtime.getURL("tesseract/"),
        workerBlobURL: false, // use the bundled worker URL directly (extension origin)
        gzip: true,
      });
      await worker.setParameters({ tessedit_pageseg_mode: "6" });
      return worker;
    })().catch((e) => {
      workerPromise = null; // allow a retry on next request
      throw e;
    });
  }
  return workerPromise;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "offscreen" || msg.type !== "ocr") return;
  (async () => {
    try {
      const worker = await getWorker();
      const { data } = await worker.recognize(msg.image);
      sendResponse({ ok: true, text: data.text || "" });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  })();
  return true; // async response
});
