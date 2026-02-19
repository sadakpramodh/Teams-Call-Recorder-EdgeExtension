/**
 * Teams Call Recorder – content script
 *
 * Responsibilities:
 *  1. Detect call state and report it to the background service worker.
 *  2. Render an on-screen control panel using Shadow DOM so that Teams'
 *     global event listeners / stylesheets cannot interfere with the panel.
 *  3. Provide live transcription via the browser-native Web Speech API and
 *     persist the final transcript for the background worker to save alongside
 *     the audio recording.
 */

// ─── Shared state ─────────────────────────────────────────────────────────────

const state = {
  callActive: false,
  meetingTitle: "",
  participantCount: null,
  recordingState: "idle",
  panelEnabled: true,
};

const POLL_MS = 1500;

// ─── Panel (Shadow DOM) refs ──────────────────────────────────────────────────

/** The fixed-position shadow host element appended to <body>. */
let panelRoot = null;
/** Shadow root attached to panelRoot for style/event isolation. */
let shadowRoot = null;

// ─── Transcription state ──────────────────────────────────────────────────────

let recognition = null;
let finalTranscript = "";
let interimText = "";

// ─── Shadow DOM inner styles ──────────────────────────────────────────────────

const SHADOW_STYLES = `
  :host { display: block; pointer-events: all; }

  .tr-container {
    font-family: "Segoe UI", Tahoma, sans-serif;
    font-size: 13px;
    color: #0f172a;
    background: linear-gradient(135deg, #f8fafc, #e2e8f0);
    border: 1px solid #cbd5e1;
    border-radius: 12px;
    box-shadow: 0 8px 24px rgba(15, 23, 42, 0.25);
    padding: 10px;
    pointer-events: all;
    box-sizing: border-box;
  }

  .tr-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
    user-select: none;
  }

  .tr-dot {
    width: 10px;
    height: 10px;
    flex-shrink: 0;
    border-radius: 50%;
    background: #64748b;
  }
  .tr-dot.rec {
    background: #dc2626;
    animation: tr-pulse 1.5s ease-in-out infinite;
  }
  .tr-dot.call { background: #16a34a; }
  @keyframes tr-pulse {
    0%, 100% { box-shadow: 0 0 0 3px rgba(220, 38, 38, 0.2); }
    50%       { box-shadow: 0 0 0 6px rgba(220, 38, 38, 0.35); }
  }

  .tr-status { font-weight: 600; }

  .tr-title {
    margin-left: auto;
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
    color: #475569;
  }

  .tr-actions {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
    margin-bottom: 4px;
  }

  button {
    border: none;
    border-radius: 8px;
    padding: 7px 0;
    font-size: 12px;
    font-family: "Segoe UI", Tahoma, sans-serif;
    cursor: pointer;
    background: #0f172a;
    color: #fff;
    pointer-events: all;
    transition: background 0.12s;
    user-select: none;
  }
  button:hover:not([disabled]) { background: #1e293b; }
  button:active:not([disabled]) { background: #334155; }
  button[disabled] { cursor: not-allowed; opacity: 0.42; }

  .tr-error {
    display: none;
    margin-top: 5px;
    padding: 4px 8px;
    background: #fee2e2;
    border-radius: 6px;
    font-size: 11px;
    color: #991b1b;
    line-height: 1.4;
  }

  /* ── Transcript area ── */
  .tr-transcript {
    margin-top: 8px;
    border-top: 1px solid #cbd5e1;
    padding-top: 7px;
  }
  .tr-transcript-label {
    font-size: 11px;
    font-weight: 600;
    color: #475569;
    margin-bottom: 4px;
    display: flex;
    align-items: center;
    gap: 5px;
    user-select: none;
  }
  .tr-live-dot {
    width: 7px;
    height: 7px;
    flex-shrink: 0;
    border-radius: 50%;
    background: #dc2626;
    animation: tr-pulse 1s ease-in-out infinite;
  }
  .tr-transcript-text {
    font-size: 11px;
    color: #1e293b;
    max-height: 80px;
    overflow-y: auto;
    line-height: 1.5;
    word-break: break-word;
    background: #f1f5f9;
    border-radius: 6px;
    padding: 5px 7px;
    min-height: 22px;
    white-space: pre-wrap;
    pointer-events: all;
    user-select: text;
  }
  .tr-transcript-text .interim {
    color: #94a3b8;
    font-style: italic;
  }
  .tr-transcript-text:empty::after {
    content: "Listening…";
    color: #94a3b8;
    font-style: italic;
  }

  .tr-badge {
    margin-top: 8px;
    font-size: 10px;
    color: #94a3b8;
    user-select: none;
  }
`;

// ─── Init ─────────────────────────────────────────────────────────────────────

init();

function init() {
  // Listen for recording state changes pushed from background.js
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "STATE_CHANGED") return;
    const prev = state.recordingState;
    state.recordingState = message.state.recordingState;
    state.callActive = message.state.callActive;

    if (state.recordingState === "recording" && prev !== "recording") {
      startTranscription();
    } else if (state.recordingState === "idle" && prev !== "idle") {
      stopTranscription();
    }
    renderPanel();
  });

  // Keep panel visibility in sync with the popup's "show controls" toggle
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.onScreenBadge) return;
    state.panelEnabled = changes.onScreenBadge.newValue !== false;
    renderPanel();
  });

  chrome.storage.local.get(["onScreenBadge"]).then((s) => {
    state.panelEnabled = s.onScreenBadge !== false;
    renderPanel();
  });

  // Inject outer positioning CSS (inner styles live in SHADOW_STYLES)
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("src/content.css");
  document.documentElement.appendChild(link);

  setInterval(pollCallState, POLL_MS);
  pollCallState();
}

// ─── Call detection ───────────────────────────────────────────────────────────

function pollCallState() {
  const titleEl =
    document.querySelector("[data-tid='meeting-title']") ||
    document.querySelector("h1") ||
    document.querySelector("title");
  const meetingTitle = (titleEl?.textContent || document.title || "TeamsCall").trim();

  const partEl =
    document.querySelector("[data-tid='call-participants-count']") ||
    document.querySelector("[aria-label*='participants']");
  const participantCount = parseParticipantCount(partEl?.textContent || "");

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
  chrome.runtime.sendMessage({ type: "CALL_STATUS_UPDATE", callActive, meetingTitle, participantCount });
}

function detectCallActive() {
  const url = location.href.toLowerCase();
  if (url.includes("/meetup-join/") || url.includes("/meeting/")) return true;
  return [
    "[data-tid='call-end']",
    "[aria-label*='Leave']",
    "[aria-label*='Hang up']",
    "[data-tid='toggle-video']",
  ].some((sel) => document.querySelector(sel));
}

function parseParticipantCount(text) {
  const m = text.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

// ─── Transcription ────────────────────────────────────────────────────────────

/**
 * Start continuous speech recognition using the browser-native Web Speech API.
 * Works on the microphone input; auto-restarts on silence/network errors while
 * recording is still active.
 */
function startTranscription() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return; // API unavailable (e.g., Firefox)

  stopTranscription(); // clean up any stale instance
  finalTranscript = "";
  interimText = "";

  try {
    recognition = new SR();
  } catch {
    return;
  }

  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || "en-US";
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        finalTranscript += event.results[i][0].transcript + " ";
      } else {
        interim += event.results[i][0].transcript;
      }
    }
    interimText = interim;
    updateTranscriptDisplay();
  };

  // Auto-restart on natural end-of-session while recording
  recognition.onend = () => {
    if (state.recordingState === "recording" || state.recordingState === "paused") {
      try { recognition.start(); } catch { /* already running */ }
    }
  };

  recognition.onerror = (event) => {
    if (event.error === "no-speech" || event.error === "aborted") return;
    // For other errors give a brief pause then try again
    setTimeout(() => {
      if (recognition && (state.recordingState === "recording" || state.recordingState === "paused")) {
        try { recognition.start(); } catch {}
      }
    }, 1500);
  };

  try {
    recognition.start();
  } catch {
    recognition = null;
  }
}

/**
 * Stop recognition and persist the accumulated transcript in local storage so
 * background.js can attach it to the finalized recording.
 */
function stopTranscription() {
  if (recognition) {
    try { recognition.abort(); } catch {}
    recognition = null;
  }
  const text = finalTranscript.trim();
  if (text) {
    chrome.storage.local.set({ pendingTranscript: text }).catch(() => {});
  }
  interimText = "";
}

/** Live-update only the transcript text node without a full panel re-render. */
function updateTranscriptDisplay() {
  if (!shadowRoot) return;
  const textEl = shadowRoot.querySelector(".tr-transcript-text");
  if (!textEl) return;
  textEl.innerHTML =
    escapeHtml(finalTranscript) +
    (interimText ? `<span class="interim">${escapeHtml(interimText)}</span>` : "");
  textEl.scrollTop = textEl.scrollHeight;
}

// ─── Panel rendering ──────────────────────────────────────────────────────────

function renderPanel() {
  if (!state.panelEnabled) {
    removePanel();
    return;
  }
  if (!state.callActive && state.recordingState === "idle") {
    removePanel();
    return;
  }

  // Create shadow host + shadow root once
  if (!panelRoot) {
    panelRoot = document.createElement("div");
    panelRoot.id = "teams-recorder-panel";
    document.body.appendChild(panelRoot);

    shadowRoot = panelRoot.attachShadow({ mode: "open" });
    const styleEl = document.createElement("style");
    styleEl.textContent = SHADOW_STYLES;
    shadowRoot.appendChild(styleEl);
  }

  const isRecording = state.recordingState === "recording";
  const isPaused    = state.recordingState === "paused";
  const showTranscript = isRecording || isPaused;

  // Replace content container on every render (style element is preserved)
  const old = shadowRoot.querySelector(".tr-container");
  if (old) old.remove();

  const container = document.createElement("div");
  container.className = "tr-container";
  container.innerHTML = `
    <div class="tr-head">
      <span class="tr-dot ${isRecording ? "rec" : state.callActive ? "call" : "idle"}"></span>
      <span class="tr-status">${isRecording ? "Recording" : isPaused ? "Paused" : state.callActive ? "Call active" : "Idle"}</span>
      <span class="tr-title">${escapeHtml(state.meetingTitle || "Teams call")}</span>
    </div>
    <div class="tr-actions">
      <button data-act="start"  ${state.recordingState !== "idle" ? "disabled" : ""}>Start</button>
      <button data-act="pause"  ${!isRecording ? "disabled" : ""}>Pause</button>
      <button data-act="resume" ${!isPaused    ? "disabled" : ""}>Resume</button>
      <button data-act="stop"   ${state.recordingState === "idle" ? "disabled" : ""}>Stop</button>
    </div>
    <div class="tr-error"></div>
    ${showTranscript ? `
    <div class="tr-transcript">
      <div class="tr-transcript-label">
        ${isRecording ? '<span class="tr-live-dot"></span>' : ""}
        Transcript
      </div>
      <div class="tr-transcript-text">${escapeHtml(finalTranscript)}${interimText ? `<span class="interim">${escapeHtml(interimText)}</span>` : ""}</div>
    </div>` : ""}
    <div class="tr-badge">Recording indicator always visible</div>
  `;
  shadowRoot.appendChild(container);

  // Wire button actions — stopPropagation keeps Teams' capture listeners away
  container.querySelectorAll("button[data-act]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      e.preventDefault();

      const act = btn.getAttribute("data-act");
      const errorEl = shadowRoot.querySelector(".tr-error");
      const msgMap = {
        start:  { type: "START_RECORDING" },
        pause:  { type: "PAUSE_RECORDING" },
        resume: { type: "RESUME_RECORDING" },
        stop:   { type: "STOP_RECORDING" },
      };
      const msg = msgMap[act];
      if (!msg) return;

      try {
        const res = await chrome.runtime.sendMessage(msg);
        if (!res?.ok) {
          showError(errorEl, res?.error || "Action failed.");
        } else if (errorEl) {
          errorEl.style.display = "none";
        }
      } catch (err) {
        showError(errorEl, err?.message || "Extension communication error.");
      }
    });
  });
}

function showError(el, text) {
  if (!el) return;
  el.textContent = text;
  el.style.display = "block";
  setTimeout(() => { el.style.display = "none"; }, 5000);
}

function removePanel() {
  if (panelRoot) {
    panelRoot.remove();
    panelRoot = null;
    shadowRoot = null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(input) {
  return String(input || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
