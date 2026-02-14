let mediaRecorder = null;
let mixedStream = null;
let tabStream = null;
let micStream = null;
let chunks = [];
let activeFormat = "webm";
let audioContext = null;
let audioDestination = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return;
  handle(message)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function handle(message) {
  switch (message.type) {
    case "OFFSCREEN_START":
      await startCapture(message.payload);
      break;
    case "OFFSCREEN_PAUSE":
      mediaRecorder?.pause();
      break;
    case "OFFSCREEN_RESUME":
      mediaRecorder?.resume();
      break;
    case "OFFSCREEN_STOP":
      await stopCapture();
      break;
    default:
      break;
  }
}

async function startCapture(payload) {
  await cleanup();
  activeFormat = payload.format || "webm";
  const sourceMode = payload.sourceMode || "both";
  const includeSystem = sourceMode === "both" || sourceMode === "system";
  const includeMic = sourceMode === "both" || sourceMode === "mic";

  if (includeSystem) {
    if (!payload.streamId) throw new Error("System audio capture is unavailable for this tab.");
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: payload.streamId,
        },
      },
      video: false,
    });
  }

  if (includeMic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch {
      micStream = null;
      if (!includeSystem) {
        throw new Error("Microphone permission is required for mic-only recording.");
      }
    }
  }

  audioContext = new AudioContext();
  if (audioContext.state === "suspended") {
    try {
      await audioContext.resume();
    } catch {
      // Ignore resume errors and continue.
    }
  }
  audioDestination = audioContext.createMediaStreamDestination();

  if (includeSystem && tabStream) {
    const tabSource = audioContext.createMediaStreamSource(tabStream);
    tabSource.connect(audioDestination);
    // Keep call audio audible in speakers while tab audio is being captured.
    tabSource.connect(audioContext.destination);
  }
  if (includeMic && micStream) {
    audioContext.createMediaStreamSource(micStream).connect(audioDestination);
  }

  mixedStream = audioDestination.stream;
  if (!mixedStream.getAudioTracks().length) {
    throw new Error("No audio source available for recording.");
  }
  chunks = [];

  if (payload.beepOnStart) playBeep(audioContext);

  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";
  mediaRecorder = new MediaRecorder(mixedStream, { mimeType });

  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };

  mediaRecorder.onstop = async () => {
    try {
      const blob = new Blob(chunks, { type: mediaRecorder?.mimeType || "audio/webm" });
      const finalized = await finalize(blob, activeFormat);
      await chrome.runtime.sendMessage({
        type: "RECORDING_FINALIZED",
        ...finalized,
      });
    } finally {
      await cleanup();
    }
  };

  mediaRecorder.start(1000);
}

async function stopCapture() {
  if (!mediaRecorder || mediaRecorder.state === "inactive") {
    await cleanup();
    return;
  }
  mediaRecorder.stop();
}

async function finalize(blob, format) {
  if (format === "wav") {
    try {
      const wavBlob = await convertWebmToWav(blob);
      return { format: "wav", blobDataUrl: await blobToDataUrl(wavBlob) };
    } catch {
      return { format: "webm", blobDataUrl: await blobToDataUrl(blob) };
    }
  }
  if (format === "mp3") {
    // Browser-native MP3 encoding is unavailable in this MVP.
    return { format: "webm", blobDataUrl: await blobToDataUrl(blob) };
  }
  return { format: "webm", blobDataUrl: await blobToDataUrl(blob) };
}

async function convertWebmToWav(webmBlob) {
  const context = new AudioContext();
  const buffer = await context.decodeAudioData(await webmBlob.arrayBuffer());
  await context.close();
  return audioBufferToWavBlob(buffer);
}

function audioBufferToWavBlob(buffer) {
  const numberOfChannels = Math.min(2, buffer.numberOfChannels);
  const sampleRate = buffer.sampleRate;
  const samples = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numberOfChannels * bytesPerSample;
  const dataSize = samples * blockAlign;
  const wavBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(wavBuffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numberOfChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples; i++) {
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const channel = buffer.getChannelData(ch);
      const clamped = Math.max(-1, Math.min(1, channel[i]));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([wavBuffer], { type: "audio/wav" });
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

function playBeep(context) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = 880;
  gain.gain.value = 0.06;
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.15);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function cleanup() {
  if (tabStream) tabStream.getTracks().forEach((t) => t.stop());
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (mixedStream) mixedStream.getTracks().forEach((t) => t.stop());
  if (audioContext) {
    try {
      await audioContext.close();
    } catch {
      // Ignore close errors.
    }
  }
  tabStream = null;
  micStream = null;
  mixedStream = null;
  audioContext = null;
  audioDestination = null;
  mediaRecorder = null;
  chunks = [];
}
