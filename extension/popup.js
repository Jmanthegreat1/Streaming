// Popup: reads/writes settings to chrome.storage.sync and talks to the active
// tab's content script for the "pick the subtitle" feature.

const LANGUAGES = {
  English: "en", Arabic: "ar", Chinese: "zh-CN", Dutch: "nl", French: "fr",
  German: "de", Greek: "el", Hindi: "hi", Italian: "it", Japanese: "ja",
  Korean: "ko", Persian: "fa", Polish: "pl", Portuguese: "pt", Romanian: "ro",
  Russian: "ru", Spanish: "es", Turkish: "tr", Ukrainian: "uk", Yiddish: "yi",
};

const DEFAULTS = {
  enabled: false, target: "en", source: "auto", backendUrl: "", showOriginal: false,
};

const $ = (id) => document.getElementById(id);

// Populate language dropdown.
for (const [name, code] of Object.entries(LANGUAGES)) {
  const opt = document.createElement("option");
  opt.value = code;
  opt.textContent = name;
  $("target").appendChild(opt);
}

// Load current settings into the UI.
chrome.storage.sync.get(DEFAULTS, (s) => {
  $("enabled").checked = s.enabled;
  $("showOriginal").checked = s.showOriginal;
  $("target").value = s.target;
  $("backendUrl").value = s.backendUrl;
});

// Persist on change.
$("enabled").addEventListener("change", (e) =>
  chrome.storage.sync.set({ enabled: e.target.checked })
);
$("showOriginal").addEventListener("change", (e) =>
  chrome.storage.sync.set({ showOriginal: e.target.checked })
);
$("target").addEventListener("change", (e) =>
  chrome.storage.sync.set({ target: e.target.value })
);
$("backendUrl").addEventListener("change", (e) =>
  chrome.storage.sync.set({ backendUrl: e.target.value.trim() })
);

function sendToTab(message) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, message, () => void chrome.runtime.lastError);
  });
}

$("teach").addEventListener("click", () => {
  chrome.storage.sync.set({ enabled: true }, () => {
    $("enabled").checked = true;
    sendToTab({ type: "startTeaching" });
    window.close(); // close popup so you can click the subtitle on the page
  });
});

$("clear").addEventListener("click", () => sendToTab({ type: "clearSelector" }));
