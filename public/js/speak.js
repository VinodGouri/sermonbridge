// Speaker page: capture English speech in the browser (Web Speech API) and
// send finished lines to the server, which translates and fans them out.

const socket = io();

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');
const transcriptEl = document.getElementById('transcript');
const sourceLangEl = document.getElementById('sourceLang');
const serviceCodeEl = document.getElementById('serviceCode');
const qrBox = document.getElementById('qrBox');
const joinLink = document.getElementById('joinLink');
const speakerKeyEl = document.getElementById('speakerKey');

// --- Service code: reuse one from the URL (?id=) or this tab, else generate. ---
function generatePin() {
  return String(Math.floor(1000 + Math.random() * 9000));
}
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

// --- Web Speech API setup ---
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let running = false;

if (!SpeechRecognition) {
  statusEl.textContent =
    'This browser has no speech recognition. Use Google Chrome on a laptop.';
  startBtn.disabled = true;
}

function appendLine(text) {
  const li = document.createElement('li');
  li.textContent = text;
  transcriptEl.appendChild(li);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

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
      stop();
    } else if (e.error !== 'no-speech') {
      statusEl.textContent = `Recognition: ${e.error}`;
    }
  };

  // Web Speech stops on its own after a pause; restart while we're live.
  rec.onend = () => { if (running) rec.start(); };
  return rec;
}

function start() {
  if (running) return;
  running = true;
  recognition = buildRecognition();
  recognition.start();
  startBtn.disabled = true;
  stopBtn.disabled = false;
  sourceLangEl.disabled = true;
  statusEl.innerHTML = '<span class="live-dot"></span>Live — speaking English';
}

function stop() {
  running = false;
  if (recognition) { recognition.onend = null; recognition.stop(); }
  startBtn.disabled = false;
  stopBtn.disabled = true;
  sourceLangEl.disabled = false;
  statusEl.textContent = 'Stopped.';
}

startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', stop);
