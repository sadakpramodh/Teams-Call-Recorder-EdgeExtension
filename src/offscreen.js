let mediaRecorder = null;
let mixedStream = null;
let tabStream = null;
let micStream = null;
let chunks = [];
let activeFormat = "webm";

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

  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: payload.streamId,
      },
    },
    video: false,
  });

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
  }

  const context = new AudioContext();
  const destination = context.createMediaStreamDestination();
  const sourceMode = payload.sourceMode || "both";

  if (sourceMode === "both" || sourceMode === "system") {
    context.createMediaStreamSource(tabStream).connect(destination);
  }
  if ((sourceMode === "both" || sourceMode === "mic") && micStream) {
    context.createMediaStreamSource(micStream).connect(destination);
  }

  mixedStream = destination.stream;
  chunks = [];

  if (payload.beepOnStart) playBeep(context);

  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";
  mediaRecorder = new MediaRecorder(mixedStream, { mimeType });

  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };

  mediaRecorder.onstop = async () => {
    const blob = new Blob(chunks, { type: "audio/webm" });
    const finalized = await finalize(blob, activeFormat);
    await chrome.runtime.sendMessage({
      type: "RECORDING_FINALIZED",
      ...finalized,
    });
    await cleanup();
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
  tabStream = null;
  micStream = null;
  mixedStream = null;
  mediaRecorder = null;
  chunks = [];
}
