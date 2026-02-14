const DEFAULT_SETTINGS = {
  sourceMode: "both",
  format: "webm",
  folder: "TeamsRecordings",
  beepOnStart: true,
  consentAccepted: false,
  onScreenBadge: true,
  notes: "",
};

const state = {
  callActive: false,
  callTabId: null,
  callTitle: "",
  participantCount: null,
  recordingState: "idle",
  recordingStartedAt: null,
  lastError: "",
  currentFilename: "",
  latestDownloadId: null,
};

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const update = {};
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (current[key] === undefined) update[key] = value;
  }
  if (Object.keys(update).length) await chrome.storage.local.set(update);
  await publishState();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) return;
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => {
      state.lastError = error?.message || String(error);
      publishState();
      sendResponse({ ok: false, error: state.lastError });
    });
  return true;
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "toggle-recording") {
    if (state.recordingState === "idle") await startRecording();
    else await stopRecording();
  }
  if (command === "pause-resume-recording") {
    if (state.recordingState === "recording") await pauseRecording();
    else if (state.recordingState === "paused") await resumeRecording();
  }
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case "CALL_STATUS_UPDATE":
      return handleCallStatus(message, sender);
    case "GET_STATE":
      return { state };
    case "START_RECORDING":
      return startRecording(message.notes || "");
    case "PAUSE_RECORDING":
      return pauseRecording();
    case "RESUME_RECORDING":
      return resumeRecording();
    case "STOP_RECORDING":
      return stopRecording();
    case "RECORDING_CHUNK_READY":
      return handleChunk(message);
    case "RECORDING_FINALIZED":
      return handleFinalized(message);
    case "LIST_RECORDINGS":
      return listRecordings();
    case "DELETE_RECORDING":
      return deleteRecording(message.id);
    default:
      return null;
  }
}

async function handleCallStatus(message, sender) {
  state.callActive = Boolean(message.callActive);
  state.callTabId = sender.tab?.id || state.callTabId;
  state.callTitle = message.meetingTitle || "";
  state.participantCount = message.participantCount ?? null;
  await publishState();
  if (!state.callActive && state.recordingState !== "idle") await stopRecording();
}

async function startRecording(notes = "") {
  const settings = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  if (!settings.consentAccepted) throw new Error("Consent disclaimer must be accepted.");
  if (state.recordingState !== "idle") throw new Error("Recording already in progress.");

  const tabId = await resolveTeamsTabId();
  if (!tabId) throw new Error("No active Teams call tab found.");
  state.callTabId = tabId;

  const sourceMode = settings.sourceMode || "both";
  const streamId =
    sourceMode === "mic"
      ? null
      : await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  await ensureOffscreenDocument();

  state.recordingState = "recording";
  state.recordingStartedAt = Date.now();
  state.lastError = "";
  state.currentFilename = makeFilename(state.callTitle, settings.format, settings.folder);
  await chrome.storage.local.set({ notes: notes || "" });
  await publishState();

  try {
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "OFFSCREEN_START",
      payload: {
        streamId,
        sourceMode,
        format: settings.format,
        beepOnStart: settings.beepOnStart,
        metadata: {
          startedAt: state.recordingStartedAt,
          meetingTitle: state.callTitle || "TeamsCall",
          participantCount: state.participantCount,
        },
      },
    });
  } catch (error) {
    state.recordingState = "idle";
    state.recordingStartedAt = null;
    state.currentFilename = "";
    await publishState();
    throw error;
  }
}

async function pauseRecording() {
  if (state.recordingState !== "recording") return;
  await chrome.runtime.sendMessage({ target: "offscreen", type: "OFFSCREEN_PAUSE" });
  state.recordingState = "paused";
  await publishState();
}

async function resumeRecording() {
  if (state.recordingState !== "paused") return;
  await chrome.runtime.sendMessage({ target: "offscreen", type: "OFFSCREEN_RESUME" });
  state.recordingState = "recording";
  await publishState();
}

async function stopRecording() {
  if (state.recordingState === "idle") return;
  await chrome.runtime.sendMessage({ target: "offscreen", type: "OFFSCREEN_STOP" });
}

async function handleChunk(_message) {
  return true;
}

async function handleFinalized(message) {
  const settings = await chrome.storage.local.get(["folder", "notes"]);
  const finalizedFormat = message.format || "webm";
  const fallbackFilename = makeFilename(state.callTitle, finalizedFormat, settings.folder);
  const finalFilename = applyFormatToFilename(
    state.currentFilename || fallbackFilename,
    finalizedFormat
  );

  try {
    const downloadId = await saveBlobToDownloads(message.blobDataUrl, finalFilename);
    state.latestDownloadId = downloadId;

    const endedAt = Date.now();
    const record = {
      id: crypto.randomUUID(),
      filename: finalFilename,
      downloadId,
      createdAt: endedAt,
      startedAt: state.recordingStartedAt,
      endedAt,
      durationSec: Math.max(0, Math.round((endedAt - (state.recordingStartedAt || endedAt)) / 1000)),
      meetingTitle: state.callTitle || "TeamsCall",
      participantCount: state.participantCount,
      notes: settings.notes || "",
      format: finalizedFormat,
      folder: settings.folder,
    };

    const metadataName = `${finalFilename.replace(/\.[^.]+$/, "")}.json`;
    await saveBlobToDownloads(
      `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(record, null, 2))}`,
      metadataName
    );

    const existing = await chrome.storage.local.get(["recordings"]);
    const recordings = Array.isArray(existing.recordings) ? existing.recordings : [];
    recordings.unshift(record);
    await chrome.storage.local.set({
      recordings: recordings.slice(0, 200),
      notes: "",
    });
  } finally {
    state.recordingState = "idle";
    state.recordingStartedAt = null;
    state.currentFilename = "";
    await publishState();
  }
}

async function listRecordings() {
  const data = await chrome.storage.local.get(["recordings"]);
  return Array.isArray(data.recordings) ? data.recordings : [];
}

async function deleteRecording(id) {
  if (!id) return;
  const data = await chrome.storage.local.get(["recordings"]);
  const recordings = Array.isArray(data.recordings) ? data.recordings : [];
  const target = recordings.find((r) => r.id === id);
  if (target?.downloadId) {
    try {
      await chrome.downloads.removeFile(target.downloadId);
    } catch {
      // Ignore if file missing or blocked.
    }
    await chrome.downloads.erase({ id: target.downloadId });
  }
  await chrome.storage.local.set({ recordings: recordings.filter((r) => r.id !== id) });
}

async function resolveTeamsTabId() {
  if (state.callTabId !== null) return state.callTabId;
  const tabs = await chrome.tabs.query({ url: "https://teams.microsoft.com/*" });
  return tabs[0]?.id ?? null;
}

async function publishState() {
  const label =
    state.recordingState === "recording"
      ? "REC"
      : state.callActive
      ? "CALL"
      : "";
  const color =
    state.recordingState === "recording"
      ? "#d91e18"
      : state.callActive
      ? "#1b8f3e"
      : "#7a7a7a";
  await chrome.action.setBadgeText({ text: label });
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.storage.local.set({ runtimeState: state });
  try {
    if (state.callTabId !== null) {
      await chrome.tabs.sendMessage(state.callTabId, { type: "STATE_CHANGED", state });
    }
  } catch {
    // Ignore if tab unavailable.
  }
}

async function ensureOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL("src/offscreen.html")],
    });
    if (contexts.length > 0) return;
  } else {
    const existing = await chrome.offscreen.hasDocument?.();
    if (existing) return;
  }
  await chrome.offscreen.createDocument({
    url: "src/offscreen.html",
    reasons: ["USER_MEDIA", "BLOBS"],
    justification: "Record Teams audio with local-only processing and file creation.",
  });
}

async function saveBlobToDownloads(blobDataUrl, filename) {
  const id = await chrome.downloads.download({
    url: blobDataUrl,
    filename,
    saveAs: false,
    conflictAction: "uniquify",
  });
  return id;
}

function makeFilename(title, format, folder) {
  const safeTitle = sanitize(title || "TeamsCall");
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const ext = normalizeExtension(format);
  return `${sanitize(folder || "TeamsRecordings")}/Teams_${yyyy}-${mm}-${dd}_${hh}-${min}_${safeTitle}.${ext}`;
}

function applyFormatToFilename(filename, format) {
  const ext = normalizeExtension(format);
  if (!filename) return `TeamsRecordings/TeamsCall.${ext}`;
  if (/\.[^.]+$/.test(filename)) return filename.replace(/\.[^.]+$/, `.${ext}`);
  return `${filename}.${ext}`;
}

function sanitize(input) {
  return String(input).replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 80);
}

function normalizeExtension(format) {
  if (format === "wav") return "wav";
  if (format === "mp3") return "webm";
  return "webm";
}
