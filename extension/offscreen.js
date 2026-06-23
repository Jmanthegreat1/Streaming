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

// Keep only near-white pixels (the subtitle text) as black-on-white.
function binarize(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      // Cap the OCR image (~720x200): a big highlighted area was huge and slow.
      const scale = Math.min(720 / img.width, 200 / img.height, 2);
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
