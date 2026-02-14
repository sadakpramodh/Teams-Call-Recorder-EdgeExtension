const state = {
  callActive: false,
  meetingTitle: "",
  participantCount: null,
  recordingState: "idle",
  panelEnabled: true,
};

const POLL_MS = 1500;
let panelRoot = null;

init();

function init() {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "STATE_CHANGED") {
      state.recordingState = message.state.recordingState;
      state.callActive = message.state.callActive;
      renderPanel();
    }
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.onScreenBadge) return;
    state.panelEnabled = changes.onScreenBadge.newValue !== false;
    renderPanel();
  });
  chrome.storage.local.get(["onScreenBadge"]).then((settings) => {
    state.panelEnabled = settings.onScreenBadge !== false;
    renderPanel();
  });

  const style = document.createElement("link");
  style.rel = "stylesheet";
  style.href = chrome.runtime.getURL("src/content.css");
  document.documentElement.appendChild(style);

  setInterval(pollCallState, POLL_MS);
  pollCallState();
}

function pollCallState() {
  const titleElement =
    document.querySelector("[data-tid='meeting-title']") ||
    document.querySelector("h1") ||
    document.querySelector("title");
  const meetingTitle = (titleElement?.textContent || document.title || "TeamsCall").trim();

  const participantLabel =
    document.querySelector("[data-tid='call-participants-count']") ||
    document.querySelector("[aria-label*='participants']");
  const participantCount = parseParticipantCount(participantLabel?.textContent || "");

  const callActive = detectCallActive();
  const changed =
    callActive !== state.callActive ||
    meetingTitle !== state.meetingTitle ||
    participantCount !== state.participantCount;
  if (!changed) return;

  state.callActive = callActive;
  state.meetingTitle = meetingTitle;
  state.participantCount = participantCount;
  renderPanel();
  chrome.runtime.sendMessage({
    type: "CALL_STATUS_UPDATE",
    callActive,
    meetingTitle,
    participantCount,
  });
}

function detectCallActive() {
  const url = location.href.toLowerCase();
  if (url.includes("/meetup-join/") || url.includes("/meeting/")) return true;
  const activeButtons = [
    "[data-tid='call-end']",
    "[aria-label*='Leave']",
    "[aria-label*='Hang up']",
    "[data-tid='toggle-video']",
  ];
  return activeButtons.some((selector) => document.querySelector(selector));
}

function parseParticipantCount(text) {
  const m = text.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

function renderPanel() {
  if (!state.panelEnabled) {
    if (panelRoot) panelRoot.remove();
    panelRoot = null;
    return;
  }
  if (!state.callActive && state.recordingState === "idle") {
    if (panelRoot) panelRoot.remove();
    panelRoot = null;
    return;
  }
  if (!panelRoot) {
    panelRoot = document.createElement("div");
    panelRoot.id = "teams-recorder-panel";
    document.body.appendChild(panelRoot);
  }

  const isRecording = state.recordingState === "recording";
  const isPaused = state.recordingState === "paused";
  panelRoot.innerHTML = `
    <div class="tr-head">
      <span class="tr-dot ${isRecording ? "rec" : state.callActive ? "call" : "idle"}"></span>
      <strong>${isRecording ? "Recording" : isPaused ? "Paused" : state.callActive ? "Call active" : "Idle"}</strong>
      <span class="tr-title">${escapeHtml(state.meetingTitle || "Teams call")}</span>
    </div>
    <div class="tr-actions">
      <button data-act="start" ${state.recordingState !== "idle" ? "disabled" : ""}>Start</button>
      <button data-act="pause" ${!isRecording ? "disabled" : ""}>Pause</button>
      <button data-act="resume" ${!isPaused ? "disabled" : ""}>Resume</button>
      <button data-act="stop" ${state.recordingState === "idle" ? "disabled" : ""}>Stop</button>
    </div>
    <div class="tr-badge">Recording indicator always visible</div>
  `;

  panelRoot.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.getAttribute("data-act");
      if (action === "start") chrome.runtime.sendMessage({ type: "START_RECORDING" });
      if (action === "pause") chrome.runtime.sendMessage({ type: "PAUSE_RECORDING" });
      if (action === "resume") chrome.runtime.sendMessage({ type: "RESUME_RECORDING" });
      if (action === "stop") chrome.runtime.sendMessage({ type: "STOP_RECORDING" });
    });
  });
}

function escapeHtml(input) {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
