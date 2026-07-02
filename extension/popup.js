// Popup: reads/writes settings and triggers the page pickers.

const LANGUAGES = {
  English: "en", Arabic: "ar", Chinese: "zh-CN", Dutch: "nl", French: "fr",
  German: "de", Greek: "el", Hindi: "hi", Italian: "it", Japanese: "ja",
  Korean: "ko", Persian: "fa", Polish: "pl", Portuguese: "pt", Romanian: "ro",
  Russian: "ru", Spanish: "es", Turkish: "tr", Ukrainian: "uk", Yiddish: "yi",
};

const DEFAULTS = { enabled: false, mode: "ocr", engine: "local", target: "en", backendUrl: "", visionKey: "" };
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
  $("ocrControls").style.display = mode === "ocr" ? "" : "none";
  $("textControls").style.display = mode === "text" ? "" : "none";
  $("req").textContent = mode === "ocr" && engine === "server" ? "(required)" : "";
  $("reqVision").textContent = mode === "ocr" && engine === "vision" ? "(required)" : "";
}

function reflectPower(on) {
  const btn = $("power");
  btn.classList.toggle("on", on);
  btn.classList.toggle("off", !on);
  $("powerLabel").textContent = on ? "ON" : "Turn ON";
}

chrome.storage.sync.get(DEFAULTS, (s) => {
  reflectPower(s.enabled);
  $("mode").value = s.mode;
  $("engine").value = s.engine;
  $("target").value = s.target;
  $("backendUrl").value = s.backendUrl;
  $("visionKey").value = s.visionKey;
  reflectControls();
});

$("engine").addEventListener("change", (e) => {
  chrome.storage.sync.set({ engine: e.target.value });
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
$("target").addEventListener("change", (e) => chrome.storage.sync.set({ target: e.target.value }));
$("backendUrl").addEventListener("change", (e) => chrome.storage.sync.set({ backendUrl: e.target.value.trim() }));
$("visionKey").addEventListener("change", (e) => chrome.storage.sync.set({ visionKey: e.target.value.trim() }));
$("mode").addEventListener("change", (e) => {
  chrome.storage.sync.set({ mode: e.target.value });
  reflectControls();
});

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
