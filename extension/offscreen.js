// Runs in the offscreen document (an extension page), where we're allowed to
// spin up the Tesseract web worker + WASM. Keeps one warm Hebrew worker, refuses
// to stack recognitions (prevents a growing backlog), and recycles periodically
// so it doesn't slow down over a long session.

let workerPromise = null;
let recognizeCount = 0;
let busy = false;

function createWorker() {
  return Tesseract.createWorker("heb", 1, {
    workerPath: chrome.runtime.getURL("tesseract/worker.min.js"),
    corePath: chrome.runtime.getURL("tesseract/tesseract-core-simd.wasm.js"),
    langPath: chrome.runtime.getURL("tesseract/"),
    workerBlobURL: false,
    gzip: true,
  }).then(async (worker) => {
    await worker.setParameters({ tessedit_pageseg_mode: "6" });
    return worker;
  });
}

function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker().catch((e) => {
      workerPromise = null; // allow retry
      throw e;
    });
  }
  return workerPromise;
}

// Recreate the worker every so often to release accumulated memory.
async function recycleIfNeeded() {
  if (recognizeCount >= 150 && workerPromise) {
    const w = await workerPromise.catch(() => null);
    workerPromise = null;
    recognizeCount = 0;
    if (w) {
      try { await w.terminate(); } catch (e) { /* ignore */ }
    }
  }
}

// Keep only near-white pixels (the subtitle text) as black-on-white, AND crop to
// just the text's bounding box — so a big highlighted area doesn't make Tesseract
// scan a huge mostly-empty image. Big speed win when the box is large.
function binarize(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const work = img.width > 1000 ? 1000 / img.width : 1; // bound the scan width
      const w = Math.max(1, Math.round(img.width * work));
      const h = Math.max(1, Math.round(img.height * work));
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      const im = ctx.getImageData(0, 0, w, h);
      const d = im.data;
      let minX = w, minY = h, maxX = -1, maxY = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const isText = d[i] >= 215 && d[i + 1] >= 215 && d[i + 2] >= 215;
          const v = isText ? 0 : 255;
          d[i] = d[i + 1] = d[i + 2] = v;
          d[i + 3] = 255;
          if (isText) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      ctx.putImageData(im, 0, 0);
      if (maxX < 0) return resolve(c); // no text found; let OCR return empty

      const pad = 6;
      const bx = Math.max(0, minX - pad), by = Math.max(0, minY - pad);
      const bw = Math.min(w - bx, maxX - minX + 1 + pad * 2);
      const bh = Math.min(h - by, maxY - minY + 1 + pad * 2);
      // Scale the tight text crop to a comfortable OCR size (cap ~760x200).
      const s = Math.min(760 / bw, 200 / bh, 3);
      const oc = document.createElement("canvas");
      oc.width = Math.max(1, Math.round(bw * s));
      oc.height = Math.max(1, Math.round(bh * s));
      oc.getContext("2d").drawImage(c, bx, by, bw, bh, 0, 0, oc.width, oc.height);
      resolve(oc);
    };
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = dataUrl;
  });
}

// Start loading the model as soon as this document exists, so it's warm by the
// time the first subtitle arrives (the content script prewarms us on enable).
getWorker().catch(() => {});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "offscreen" || msg.type !== "ocr") return;
  if (busy) {
    sendResponse({ ok: false, busy: true }); // don't stack work — skip this one
    return true;
  }
  busy = true;
  (async () => {
    try {
      await recycleIfNeeded();
      const worker = await getWorker();
      const canvas = await binarize(msg.image);
      const { data } = await worker.recognize(canvas, {}, {
        text: true, blocks: false, hocr: false, tsv: false, box: false, unlv: false, osd: false,
      });
      recognizeCount++;
      sendResponse({ ok: true, text: data.text || "" });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    } finally {
      busy = false;
    }
  })();
  return true;
});
