# Live Subtitle Translator

Translate a web player's subtitles to **English** (or any language) **live**, while you
watch — built for **כאן / Kan** and other sites whose subtitles are real text. A Chrome/Edge
extension does the on-screen part; an optional translation service runs on **Render**.

Plug your laptop into the TV with an **HDMI cable**, turn the extension on, and the English
subtitles appear on the big screen. No subtitle files, no per-show steps.

```
Streaming/
├─ app.py            translation API (deploy to Render)
├─ requirements.txt
├─ render.yaml       Render blueprint
├─ Procfile
└─ extension/        the browser add-on (load this into Chrome/Edge)
   ├─ manifest.json
   ├─ background.js
   ├─ content.js
   ├─ popup.html / popup.js
   └─ overlay.css
```

---

## 1. Install the extension (do this first — it works on its own)

You can start using it **immediately**, before touching Render: the extension falls back to
translating directly if no server is set.

1. Open **`chrome://extensions`** (or `edge://extensions`).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select the **`extension`** folder.
4. Pin the extension; its icon opens the popup.

## 2. Watch with English subtitles

1. Connect the laptop to the TV with an **HDMI cable** (TV = the big screen).
2. Open **kan.org.il**, start your show, turn on its Hebrew subtitles.
3. Click the extension icon → flip **Translation** on → pick **English**.
4. Play. English should appear at the bottom. Make the video **fullscreen** for the TV.

**If English doesn't appear by itself**, the player draws subtitles in its own way — just
teach it once:

- Click the extension icon → **Click to pick the subtitle**.
- The popup closes; **tap the Hebrew subtitle text on screen once**.
- Done — it locks onto that spot and translates from then on.

Use **Show original too** if you want Hebrew and English together. **Reset to automatic**
clears a taught spot.

---

## 3. (Optional) Put the translation service on Render

The extension works without this, but a Render backend makes translations more reliable
(the free public endpoint can rate-limit heavy use). This is the "on the internet" piece.

1. Put this folder in a **GitHub repo**:
   ```
   git init
   git add .
   git commit -m "Subtitle translator"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
2. On **render.com** → **New ► Blueprint** → connect that repo. Render reads `render.yaml`
   and deploys a free web service. (Or **New ► Web Service**, build `pip install -r
   requirements.txt`, start `gunicorn app:app`.)
3. Copy the service URL, e.g. `https://subtitle-translate.onrender.com`.
4. In the extension popup → **Advanced** → paste it into **Render backend URL**.

> Free Render services sleep when idle, so the first translation after a pause may take a
> few seconds to wake the server.

### Run the backend locally instead (to test)
```
pip install -r requirements.txt
python app.py            # serves http://localhost:5000
```
Then put `http://localhost:5000` in the popup's backend field.

---

## What works, and what can't

- **Works:** sites that show subtitles as real text (Kan, YouTube, many web players),
  watched in a desktop browser. Cast or HDMI it to the TV.
- **Can't work — by design, not effort:** native TV apps (the TV walls apps off from each
  other), DRM services (Netflix/Disney+/Max/Prime — their video is unreadable to any
  add-on), and subtitles **burned into the video picture** (the extension reads text, not
  pixels — for those, the Google Translate phone-camera trick is the fallback).

## Notes
- Translation uses Google Translate; no API key needed.
- Repeated lines are cached, so common phrases translate instantly.
- Broad site permissions are so it can find Kan's player wherever it loads (including
  embedded frames). It only does anything when you switch it on.
