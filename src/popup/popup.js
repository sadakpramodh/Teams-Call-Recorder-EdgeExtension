const refs = {
  statusRow: document.getElementById("statusRow"),
  errorRow: document.getElementById("errorRow"),
  consent: document.getElementById("consent"),
  sourceMode: document.getElementById("sourceMode"),
  format: document.getElementById("format"),
  folder: document.getElementById("folder"),
  beepOnStart: document.getElementById("beepOnStart"),
  startBtn: document.getElementById("startBtn"),
  pauseBtn: document.getElementById("pauseBtn"),
  resumeBtn: document.getElementById("resumeBtn"),
  stopBtn: document.getElementById("stopBtn"),
  notes: document.getElementById("notes"),
  recordings: document.getElementById("recordings"),
};

init();

async function init() {
  wireEvents();
  await hydrateSettings();
  await refreshState();
  await refreshRecordings();
  setInterval(refreshState, 1200);
}

function wireEvents() {
  refs.startBtn.addEventListener("click", async () => {
    await sendAction({ type: "START_RECORDING", notes: refs.notes.value.trim() });
    await refreshState();
  });
  refs.pauseBtn.addEventListener("click", async () => {
    await sendAction({ type: "PAUSE_RECORDING" });
    await refreshState();
  });
  refs.resumeBtn.addEventListener("click", async () => {
    await sendAction({ type: "RESUME_RECORDING" });
    await refreshState();
  });
  refs.stopBtn.addEventListener("click", async () => {
    await sendAction({ type: "STOP_RECORDING" });
    await refreshState();
    setTimeout(refreshRecordings, 900);
  });

  refs.consent.addEventListener("change", persistSettings);
  refs.sourceMode.addEventListener("change", persistSettings);
  refs.format.addEventListener("change", persistSettings);
  refs.folder.addEventListener("change", persistSettings);
  refs.beepOnStart.addEventListener("change", persistSettings);
  refs.notes.addEventListener("change", () => chrome.storage.local.set({ notes: refs.notes.value.trim() }));
}

async function hydrateSettings() {
  const settings = await chrome.storage.local.get([
    "consentAccepted",
    "sourceMode",
    "format",
    "folder",
    "beepOnStart",
    "notes",
  ]);
  refs.consent.checked = Boolean(settings.consentAccepted);
  refs.sourceMode.value = settings.sourceMode || "both";
  refs.format.value = settings.format || "webm";
  refs.folder.value = settings.folder || "TeamsRecordings";
  refs.beepOnStart.checked = settings.beepOnStart !== false;
  refs.notes.value = settings.notes || "";
}

async function persistSettings() {
  await chrome.storage.local.set({
    consentAccepted: refs.consent.checked,
    sourceMode: refs.sourceMode.value,
    format: refs.format.value,
    folder: refs.folder.value.trim() || "TeamsRecordings",
    beepOnStart: refs.beepOnStart.checked,
  });
}

async function refreshState() {
  const response = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  const runtime = response?.result?.state || {};
  const cls =
    runtime.recordingState === "recording"
      ? "rec"
      : runtime.recordingState === "paused"
      ? "paused"
      : runtime.callActive
      ? "call"
      : "idle";
  const label =
    runtime.recordingState === "recording"
      ? "Recording"
      : runtime.recordingState === "paused"
      ? "Paused"
      : runtime.callActive
      ? "Call active"
      : "Idle";
  refs.statusRow.className = `status ${cls}`;
  refs.statusRow.textContent = label;

  refs.startBtn.disabled = runtime.recordingState !== "idle" || !refs.consent.checked;
  refs.pauseBtn.disabled = runtime.recordingState !== "recording";
  refs.resumeBtn.disabled = runtime.recordingState !== "paused";
  refs.stopBtn.disabled = runtime.recordingState === "idle";
}

async function sendAction(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    refs.errorRow.hidden = false;
    refs.errorRow.textContent = response?.error || "Action failed.";
  } else {
    refs.errorRow.hidden = true;
    refs.errorRow.textContent = "";
  }
}

async function refreshRecordings() {
  const response = await chrome.runtime.sendMessage({ type: "LIST_RECORDINGS" });
  const list = response?.result || [];
  if (!list.length) {
    refs.recordings.innerHTML = "<small>No recordings yet.</small>";
    return;
  }
  refs.recordings.innerHTML = "";
  list.slice(0, 20).forEach((rec) => refs.recordings.appendChild(renderRecord(rec)));
}

function renderRecord(rec) {
  const el = document.createElement("div");
  el.className = "record";
  const date = new Date(rec.createdAt).toLocaleString();
  el.innerHTML = `
    <div class="top">${escapeHtml(rec.filename)}</div>
    <div class="meta">${date} · ${rec.durationSec || 0}s · ${escapeHtml(rec.meetingTitle || "Teams call")}</div>
    <div class="actions">
      <button data-act="show">Show</button>
      <button data-act="open">Open</button>
      <button data-act="delete">Delete</button>
    </div>
  `;
  el.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const act = btn.getAttribute("data-act");
      if (act === "show" && rec.downloadId) await chrome.downloads.show(rec.downloadId);
      if (act === "open" && rec.downloadId) {
        try {
          await chrome.downloads.open(rec.downloadId);
        } catch {
          await chrome.downloads.show(rec.downloadId);
        }
      }
      if (act === "delete") {
        await chrome.runtime.sendMessage({ type: "DELETE_RECORDING", id: rec.id });
        await refreshRecordings();
      }
    });
  });
  return el;
}

function escapeHtml(input) {
  return String(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
