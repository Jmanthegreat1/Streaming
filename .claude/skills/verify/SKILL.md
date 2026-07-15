---
name: verify
description: Drive the Live Subtitle Translator extension end-to-end in a real browser against a public HLS stream.
---

# Verifying this project

## Extension (the main surface)
Chrome **stable ignores `--load-extension`** (v137+). Use Chrome for Testing:

```bash
cd <scratchpad> && npm i puppeteer-core && npx @puppeteer/browsers install chrome@stable
```

Recipe (see the pattern in a past session's `drive3.js` / `drive4.js` — drive4 also
checks priming holds the video and that the shadow NEVER seeks forward while ahead).
Old scratchpads keep `node_modules` + `page.html`, but temp cleanup may delete the
Chrome binary itself — if launch says "Browser was not found", reinstall with
`npx @puppeteer/browsers install chrome@150.0.7871.115` (a zombie chrome.exe from a
crashed run also blocks relaunch: kill scratchpad-path chrome.exe, not the user's).
1. Serve a small HTML page over **http://localhost** (content scripts don't run on `file://`)
   that plays a public HLS VOD via hls.js CDN — `https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8`.
2. `puppeteer.launch({ executablePath: <chrome-for-testing>, headless: false,
   args: ["--disable-extensions-except=<repo>/extension", "--load-extension=<repo>/extension",
   "--autoplay-policy=no-user-gesture-required", "--mute-audio"] })`.
3. Get the extension id from the service-worker target URL. Open
   `chrome-extension://<id>/popup.html` in a tab and set settings via
   `chrome.storage.sync.set({ enabled, mode:"ocr", engine:"server", ocrRegion:{fx,fy,fw,fh}, backendUrl })`.
4. **Keep the video tab foregrounded** (`page.bringToFront()`) — backgrounded, the video
   stalls and the shadow player (correctly) pauses, so nothing scans.
5. Observe: `document.querySelector('video[data-subtrans-shadow]')` is the shadow player
   (shared DOM); its `currentTime` should sit ~8s ahead of the main video. Ask the content
   script for state via `chrome.tabs.sendMessage(tabId, {type:"getStatus"})` from the popup
   tab — returns `{enabled, mode, region, manifest, la:{state, coveredUntil, cues, lead}}`.
6. Console lines tagged `[SubTrans]` show manifest discovery, shadow startup, and per-OCR timing.

Gotcha: when the popup is opened as a normal *tab*, its own status card says
"No video page detected" (tabs.query returns the popup tab itself) — test artifact only.

**Kan itself can't be tested from this machine**: kan.org.il pages load, but the
Redge CDN (`*.il.cdn-redge.media`) geo-blocks every media request with 403 — the
video never leaves readyState 0 (the user watches via VPN). Player facts learned
anyway: inline top-frame `div.redge-player` (no player iframe), HLS VOD at
`.../Manifest.ism/playlist.m3u8?fmp4`, `data-auto-play="false"`, pre-roll ads.
For Kan-shaped flows use the local ad-then-content swap page (`page-ad.html` +
`drive-ad.js`, this session's scratchpad) which mimics: content manifest fetched
at page load → "ad" plays → swap on the same `<video>` (emptied/loadstart).

## Server
`https://jmanthegreat1-subtitle-translate.hf.space` (deploy = `git push space main`).
Time endpoints with curl **on one connection** (separate curl runs pay ~0.7s TLS setup):
generate a Hebrew subtitle PNG with PowerShell System.Drawing, POST
`{"image":"data:image/png;base64,...","lang":"heb","target":"en"}` to `/ocr-translate`.
Warm round trip should be ~0.3s.

No local Python on this machine — server changes are verified against the deployed Space.
