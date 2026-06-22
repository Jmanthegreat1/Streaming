# Live Subtitle Translator

Translate a web player's subtitles to **English** (or any language) **live**, while you
watch. Built for **כאן / Kan**, whose Hebrew subtitles are **burned into the picture** —
so the extension reads them off the screen with OCR, translates them, and shows English
just above them.

Connect your laptop to the TV with an **HDMI cable**, go fullscreen, turn it on, and the
English subtitles appear on the big screen.

```
Streaming/
├─ app.py            translation + OCR API (deploy to Render)
├─ Dockerfile        installs Tesseract + Hebrew for Render
├─ render.yaml       Render blueprint (Docker)
├─ requirements.txt
└─ extension/        the browser add-on (load into Chrome/Edge)
```

## Two modes
- **The screen (OCR)** — reads burned-in subtitles off the video. *This is the one for Kan.*
  Requires the Render backend.
- **Page text** — reads real subtitle text from the page (YouTube, etc.). Works without a
  backend.

---

## 1. Put the backend on Render (required for OCR)

OCR runs server-side (Tesseract), so the Render service is needed for Kan.

1. Push this folder to a **GitHub repo** (see step 3 — you've already started this).
2. On **render.com** → **New ► Blueprint** → pick the repo. It reads `render.yaml` and
   builds the **Docker** image (Tesseract + Hebrew included). First build takes a few minutes.
3. Copy the service URL, e.g. `https://subtitle-translate.onrender.com`.

> The free plan sleeps when idle, so the **first** subtitle after a pause may take ~30s
> while the server wakes; after that it's quick.

## 2. Install the extension

1. Open **`chrome://extensions`** (or `edge://extensions`) → enable **Developer mode**.
2. **Load unpacked** → select the **`extension`** folder. Pin it.

## 3. Watch with English subtitles (Kan)

1. Connect the laptop to the TV by **HDMI**.
2. Open the extension popup → paste your Render URL into **Render backend URL**.
3. Set **Read subtitles from → The screen (OCR)** and **Translate to → English**; turn
   **Translation on**.
4. Play your show on kan.org.il and make the video **fullscreen**.
5. Open the popup → **Select subtitle area** → drag a box over where the Hebrew subtitles
   appear. *(Do this while fullscreen so it stays aligned.)*
6. English now appears just above the Hebrew. **Reset selection** lets you redo the box.

---

## Honest limits
- **The Hebrew stays on screen.** It's baked into the video — no extension can erase it —
  so the English is shown *above* it, not in its place.
- **OCR isn't perfect.** Clean subtitles read well; busy frames or stylized fonts cause the
  odd mistake.
- **Active tab only.** Screen capture needs the video tab to be the visible one (fine for
  watching; don't switch tabs).
- **Re-select after toggling fullscreen.** The box is tied to the screen, so pick it once
  you're in the mode you'll watch in (fullscreen for the TV).
- **DRM / native TV apps** still can't be read — this is for the Kan web player.

## Instant fallback
The **Google Translate phone app → Camera** points at the TV and overlays English on the
Hebrew live — zero setup, any service. Use it any time the extension is being fussy.

## Local development
```
pip install -r requirements.txt
# point Flask at a local Tesseract (Windows example):
set TESSERACT_CMD=C:\Program Files\Tesseract-OCR\tesseract.exe
set TESSDATA_PREFIX=<folder with heb.traineddata>
python app.py            # http://localhost:5000
```
Put `http://localhost:5000` in the popup's backend field to test without Render.
