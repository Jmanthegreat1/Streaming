// Popup: settings + a live status card showing what the extension is doing on
// the current tab (synced ahead / instant mode / what's missing).

const LANGUAGES = {
  English: "en", Arabic: "ar", Chinese: "zh-CN", Dutch: "nl", French: "fr",
  German: "de", Greek: "el", Hindi: "hi", Italian: "it", Japanese: "ja",
  Korean: "ko", Persian: "fa", Polish: "pl", Portuguese: "pt", Romanian: "ro",
  Russian: "ru", Spanish: "es", Turkish: "tr", Ukrainian: "uk", Yiddish: "yi",
};

const DEFAULTS = {
  enabled: false,
  mode: "ocr",
  engine: "server",
  target: "en",
  backendUrl: "https://jmanthegreat1-subtitle-translate.hf.space",
  visionKey: "",
};
const $ = (id) => document.getElementById(id);

for (const [name, code] of Object.entries(LANGUAGES)) {
  const opt = document.createElement("option");
  opt.value = code;
  opt.textContent = name;
  $("target").appendChild(opt);
}

function reflectControls() {
  const mode = $("mode").value;
  const engine = $("engine").value;
  $("engineRow").style.display = mode === "ocr" ? "" : "none";
  $("selectArea").style.display = mode === "ocr" ? "" : "none";
  $("textControls").style.display = mode === "text" ? "" : "none";
  $("visionField").style.display = mode === "ocr" && engine === "vision" ? "" : "none";
  $("serverField").style.display = mode === "ocr" && engine === "server" ? "" : "none";
}

function reflectPower(on) {
  const btn = $("power");
  btn.classList.toggle("on", on);
  btn.classList.toggle("off", !on);
  $("powerLabel").textContent = on ? "ON" : "Turn ON";
}

// ---------- status card ----------
function setStatus(kind, title, sub) {
  const box = $("status");
  box.classList.toggle("good", kind === "good");
  box.classList.toggle("warn", kind === "warn");
  $("statusTitle").textContent = title;
  $("statusSub").textContent = sub || "";
}

function renderStatus(s) {
  if (!s) {
    setStatus("idle", "No video page detected",
      "Open the show you want to watch, then reopen this popup.");
    return;
  }
  if (!s.enabled) {
    setStatus("idle", "Off", "Press the button above to start.");
    return;
  }
  if (s.mode === "text") {
    setStatus("good", "Reading the page's own subtitles", "");
    return;
  }
  if (!s.region) {
    setStatus("warn", "No subtitle box yet",
      "Press “Select subtitle area” and drag a box over the Hebrew subtitles.");
    return;
  }
  const la = s.la || { state: "off" };
  if (la.state === "synced") {
    setStatus("good", "Synced — translations arrive on time",
      "Reading the stream " + Math.round(la.lead || 8) + "s ahead of playback.");
  } else if (la.state === "building") {
    setStatus("warn", "Preparing sync…",
      "Buffering the stream ahead. Instant mode covers you meanwhile (~1s behind).");
  } else if (la.state === "unavailable") {
    setStatus("warn", "Instant mode (~1s behind)", "Sync isn't possible here: " + (la.detail || "unknown reason") + ".");
  } else {
    setStatus("warn", "Instant mode (~1s behind)",
      s.manifest ? "Starting the sync engine…" : "Waiting to spot the video stream — press play.");
  }
}

function pollStatus() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return renderStatus(null);
    chrome.tabs.sendMessage(tabs[0].id, { type: "getStatus" }, (resp) => {
      if (chrome.runtime.lastError || !resp) return renderStatus(null);
      renderStatus(resp);
    });
  });
}
pollStatus();
setInterval(pollStatus, 1000);

// ---------- settings wiring ----------
chrome.storage.sync.get(DEFAULTS, (s) => {
  reflectPower(s.enabled);
  $("mode").value = s.mode;
  $("engine").value = s.engine;
  $("target").value = s.target;
  $("backendUrl").value = s.backendUrl;
  $("visionKey").value = s.visionKey;
  reflectControls();
});

$("power").addEventListener("click", () => {
  const on = !$("power").classList.contains("on");
  reflectPower(on);
  chrome.storage.sync.set({ enabled: on });
});

// Keep the button in sync if another control flips it (e.g. Select subtitle area).
chrome.storage.onChanged.addListener((changes) => {
  if (changes.enabled) reflectPower(changes.enabled.newValue);
});

$("engine").addEventListener("change", (e) => {
  chrome.storage.sync.set({ engine: e.target.value });
  reflectControls();
});
$("mode").addEventListener("change", (e) => {
  chrome.storage.sync.set({ mode: e.target.value });
  reflectControls();
});
$("target").addEventListener("change", (e) => chrome.storage.sync.set({ target: e.target.value }));
$("backendUrl").addEventListener("change", (e) => chrome.storage.sync.set({ backendUrl: e.target.value.trim() }));
$("visionKey").addEventListener("change", (e) => chrome.storage.sync.set({ visionKey: e.target.value.trim() }));

function sendToTab(message, close) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, message, () => void chrome.runtime.lastError);
      if (close) window.close();
    }
  });
}

$("selectArea").addEventListener("click", () =>
  chrome.storage.sync.set({ enabled: true, mode: "ocr" }, () => sendToTab({ type: "startRegionSelect" }, true))
);
$("teach").addEventListener("click", () =>
  chrome.storage.sync.set({ enabled: true, mode: "text" }, () => sendToTab({ type: "startTeaching" }, true))
);
$("clear").addEventListener("click", () => sendToTab({ type: "clearSelector" }, false));
