// Runs in the offscreen document. Hosts a POOL of Tesseract workers (one per
// spare CPU core) via a scheduler, so several subtitle lines can be read in
// parallel instead of one-at-a-time. This stops lines getting skipped when they
// change faster than a single OCR pass takes.

const POOL = Math.min(6, Math.max(2, (navigator.hardwareConcurrency || 4) - 1));
let schedulerPromise = null;

function makeWorker() {
  return Tesseract.createWorker("heb", 1, {
    workerPath: chrome.runtime.getURL("tesseract/worker.min.js"),
    corePath: chrome.runtime.getURL("tesseract/tesseract-core-simd.wasm.js"),
    langPath: chrome.runtime.getURL("tesseract/"),
    workerBlobURL: false,
    gzip: true,
  }).then(async (w) => {
    await w.setParameters({ tessedit_pageseg_mode: "6" });
    return w;
  });
}

function getScheduler() {
  if (!schedulerPromise) {
    schedulerPromise = (async () => {
      const scheduler = Tesseract.createScheduler();
      const workers = await Promise.all(Array.from({ length: POOL }, makeWorker));
      workers.forEach((w) => scheduler.addWorker(w));
      return scheduler;
    })().catch((e) => {
      schedulerPromise = null; // allow retry
      throw e;
    });
  }
  return schedulerPromise;
}

// Start loading the pool as soon as this document exists (content prewarms us).
getScheduler().catch(() => {});

// Keep only near-white pixels (the subtitle text) as black-on-white, AND crop to
// just the text's bounding box so a big highlighted area isn't a huge image.
function binarize(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const work = img.width > 1000 ? 1000 / img.width : 1;
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
          const isText = d[i] >= 200 && d[i + 1] >= 200 && d[i + 2] >= 200;
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
      if (maxX < 0) return resolve(c);

      const pad = 6;
      const bx = Math.max(0, minX - pad), by = Math.max(0, minY - pad);
      const bw = Math.min(w - bx, maxX - minX + 1 + pad * 2);
      const bh = Math.min(h - by, maxY - minY + 1 + pad * 2);
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "offscreen" || msg.type !== "ocr") return;
  (async () => {
    try {
      const scheduler = await getScheduler();
      const canvas = await binarize(msg.image);
      const { data } = await scheduler.addJob("recognize", canvas, {}, {
        text: true, blocks: false, hocr: false, tsv: false, box: false, unlv: false, osd: false,
      });
      sendResponse({ ok: true, text: data.text || "" });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  })();
  return true;
});
