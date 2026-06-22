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

// Keep only near-white pixels (the subtitle text) as black-on-white, mirroring
// the server, so Tesseract gets a clean image.
function binarize(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = img.width < 900 ? 900 / img.width : 1;
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.width * scale));
      c.height = Math.max(1, Math.round(img.height * scale));
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const im = ctx.getImageData(0, 0, c.width, c.height);
      const d = im.data;
      for (let i = 0; i < d.length; i += 4) {
        const v = d[i] >= 215 && d[i + 1] >= 215 && d[i + 2] >= 215 ? 0 : 255;
        d[i] = d[i + 1] = d[i + 2] = v;
        d[i + 3] = 255;
      }
      ctx.putImageData(im, 0, 0);
      resolve(c);
    };
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = dataUrl;
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "offscreen" || msg.type !== "ocr") return;
  (async () => {
    try {
      const worker = await getWorker();
      const canvas = await binarize(msg.image);
      const { data } = await worker.recognize(canvas);
      sendResponse({ ok: true, text: data.text || "" });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  })();
  return true; // async response
});
