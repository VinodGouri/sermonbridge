// Speaker page: capture English speech and send to the server.
//
// Two modes:
//   1. **Deepgram (server)** – streams raw PCM audio via socket.io to the
//      server, which forwards it to Deepgram for STT. Works in any browser
//      that supports getUserMedia (all modern browsers).
//   2. **Browser (Web Speech API)** – the original path, uses the browser's
//      built-in recognition. Chrome-only on desktop.

const socket = io();

const startBtn    = document.getElementById('startBtn');
const stopBtn     = document.getElementById('stopBtn');
const statusEl    = document.getElementById('status');
const transcriptEl = document.getElementById('transcript');
const sourceLangEl = document.getElementById('sourceLang');
const serviceCodeEl = document.getElementById('serviceCode');
const qrBox       = document.getElementById('qrBox');
const joinLink    = document.getElementById('joinLink');
const speakerKeyEl = document.getElementById('speakerKey');
const sttModeEl   = document.getElementById('sttMode');

// --- Service code ---
function generatePin() { return String(Math.floor(1000 + Math.random() * 9000)); }
const urlId = new URLSearchParams(location.search).get('id');
let serviceCode = urlId || sessionStorage.getItem('serviceCode') || generatePin();
sessionStorage.setItem('serviceCode', serviceCode);
serviceCodeEl.textContent = serviceCode;

const listenUrl = `${location.origin}/listen?id=${serviceCode}`;
joinLink.innerHTML = `Listeners open: <a href="${listenUrl}" target="_blank">${listenUrl}</a>`;
fetch(`/qr?id=${encodeURIComponent(serviceCode)}`)
  .then((r) => r.text())
  .then((svg) => { qrBox.innerHTML = svg; })
  .catch(() => { qrBox.style.display = 'none'; });

// --- Helpers ---
function appendLine(text) {
  const li = document.createElement('li');
  li.textContent = text;
  transcriptEl.appendChild(li);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

let running = false;

// =====================================================================
// MODE: Deepgram (server-side STT via audio stream)
// =====================================================================
let mediaStream = null;
let audioWorkletNode = null;
let audioContext = null;
let processor = null;
let dgReady = false;

// Target sample rate for Deepgram (must match server config).
const DG_SAMPLE_RATE = 16000;

// Downsample Float32Array from srcRate to targetRate.
function downsample(buffer, srcRate, targetRate) {
  if (srcRate === targetRate) return buffer;
  const ratio = srcRate / targetRate;
  const len = Math.round(buffer.length / ratio);
  const result = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    result[i] = buffer[idx] + (frac && idx + 1 < buffer.length ? frac * (buffer[idx + 1] - buffer[idx]) : 0);
  }
  return result;
}

// Convert Float32 PCM [-1, 1] → Int16 PCM.
function float32ToInt16(float32) {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return int16;
}

async function startDeepgram() {
  if (running) return;

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      }
    });
  } catch (err) {
    statusEl.textContent = 'Microphone permission denied.';
    return;
  }

  running = true;
  dgReady = false;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  sourceLangEl.disabled = true;
  sttModeEl.disabled = true;
  statusEl.innerHTML = '<span class="live-dot"></span>Connecting to Deepgram…';

  // Tell the server to open a Deepgram session.
  socket.emit('deepgram:start', {
    serviceCode,
    speakerKey: speakerKeyEl ? speakerKeyEl.value : '',
    language: sourceLangEl.value,
  });
}

// Server says the Deepgram connection is live — start streaming audio.
socket.on('deepgram:ready', () => {
  if (!running || !mediaStream) return;
  dgReady = true;
  statusEl.innerHTML = '<span class="live-dot"></span>Live — Deepgram';

  // AudioContext may pick the device's native rate (e.g. 44100 or 48000);
  // we downsample to 16 kHz before sending.
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const actualRate = audioContext.sampleRate;
  console.log(`[deepgram] AudioContext sampleRate = ${actualRate}, target = ${DG_SAMPLE_RATE}`);

  const source = audioContext.createMediaStreamSource(mediaStream);

  // ScriptProcessorNode (still widely supported despite deprecation).
  processor = audioContext.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (e) => {
    if (!running || !dgReady) return;
    const float32 = e.inputBuffer.getChannelData(0);
    const resampled = downsample(float32, actualRate, DG_SAMPLE_RATE);
    const int16 = float32ToInt16(resampled);
    socket.emit('deepgram:audio', int16.buffer);
  };

  source.connect(processor);
  processor.connect(audioContext.destination);
});

socket.on('deepgram:transcript', ({ text }) => {
  if (text) appendLine(text);
});

socket.on('deepgram:error', ({ message }) => {
  console.error('[deepgram] error from server:', message);
  statusEl.textContent = `Deepgram error: ${message}`;
  stopAll();
});

socket.on('deepgram:closed', () => {
  if (running) {
    statusEl.textContent = 'Deepgram connection closed unexpectedly.';
    stopAll();
  }
});

function stopDeepgram() {
  dgReady = false;
  socket.emit('deepgram:stop');
  if (processor) { processor.disconnect(); processor = null; }
  if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; }
  if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
}

// =====================================================================
// MODE: Browser (Web Speech API) — the original path
// =====================================================================
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;

function buildRecognition() {
  const rec = new SpeechRecognition();
  rec.lang = sourceLangEl.value;
  rec.continuous = true;
  rec.interimResults = true;

  rec.onresult = (event) => {
    let finalText = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const chunk = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalText += chunk;
    }
    if (finalText.trim()) {
      const line = finalText.trim();
      appendLine(line);
      socket.emit('transcriptReady', {
        serviceCode,
        transcript: line,
        speakerKey: speakerKeyEl ? speakerKeyEl.value : ''
      });
    }
  };

  rec.onerror = (e) => {
    if (e.error === 'not-allowed') {
      statusEl.textContent = 'Microphone permission was denied.';
      stopAll();
    } else if (e.error !== 'no-speech') {
      statusEl.textContent = `Recognition: ${e.error}`;
    }
  };

  rec.onend = () => { if (running) rec.start(); };
  return rec;
}

function startBrowser() {
  if (running) return;
  if (!SpeechRecognition) {
    statusEl.textContent = 'This browser has no speech recognition. Use Deepgram mode or Google Chrome.';
    return;
  }
  running = true;
  recognition = buildRecognition();
  recognition.start();
  startBtn.disabled = true;
  stopBtn.disabled = false;
  sourceLangEl.disabled = true;
  sttModeEl.disabled = true;
  statusEl.innerHTML = '<span class="live-dot"></span>Live — Browser Speech API';
}

function stopBrowser() {
  if (recognition) { recognition.onend = null; recognition.stop(); recognition = null; }
}

// =====================================================================
// Start / Stop dispatching based on selected mode
// =====================================================================
function start() {
  if (sttModeEl.value === 'deepgram') startDeepgram();
  else startBrowser();
}

function stopAll() {
  if (!running) return;
  running = false;
  stopDeepgram();
  stopBrowser();
  startBtn.disabled = false;
  stopBtn.disabled = true;
  sourceLangEl.disabled = false;
  sttModeEl.disabled = false;
  statusEl.textContent = 'Stopped.';
}

startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', stopAll);

// Disable browser mode option if Web Speech API is not available.
if (!SpeechRecognition) {
  const browserOpt = sttModeEl.querySelector('option[value="browser"]');
  if (browserOpt) browserOpt.textContent += ' (not available)';
}
