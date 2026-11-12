// Listener page: pick a language, join the service, read the translation live.

const socket = io();

const joinPanel = document.getElementById('joinPanel');
const translationPanel = document.getElementById('translationPanel');
const serviceCodeInput = document.getElementById('serviceCodeInput');
const langSelect = document.getElementById('langSelect');
const joinBtn = document.getElementById('joinBtn');
const translationEl = document.getElementById('translation');
const langLabel = document.getElementById('langLabel');
const codeLabel = document.getElementById('codeLabel');
const changeLink = document.getElementById('changeLink');
const waiting = document.getElementById('waiting');

// Populate the language dropdown (Telugu is first in the list).
for (const lang of window.LANGUAGES) {
  const opt = document.createElement('option');
  opt.value = lang.key;
  opt.textContent = lang.value;
  langSelect.appendChild(opt);
}

// Prefill the code from the URL (?id=) or last time.
const urlId = new URLSearchParams(location.search).get('id');
serviceCodeInput.value = urlId || localStorage.getItem('serviceCode') || '';
langSelect.value = localStorage.getItem('lang') || 'te';

let currentRoom = null;

function joinService(code, lang) {
  if (currentRoom) socket.emit('leave', currentRoom);
  currentRoom = `${code}:${lang}`;
  socket.emit('join', currentRoom);

  localStorage.setItem('serviceCode', code);
  localStorage.setItem('lang', lang);

  const label = window.LANGUAGES.find((l) => l.key === lang);
  langLabel.textContent = label ? label.value : lang;
  codeLabel.textContent = code;

  translationEl.innerHTML = '';
  waiting.style.display = 'block';
  joinPanel.style.display = 'none';
  translationPanel.style.display = 'block';
}

joinBtn.addEventListener('click', () => {
  const code = serviceCodeInput.value.trim();
  if (!code) { serviceCodeInput.focus(); return; }
  joinService(code, langSelect.value);
});

changeLink.addEventListener('click', (e) => {
  e.preventDefault();
  if (currentRoom) { socket.emit('leave', currentRoom); currentRoom = null; }
  translationPanel.style.display = 'none';
  joinPanel.style.display = 'block';
});

socket.on('translation', (msg) => {
  waiting.style.display = 'none';
  const li = document.createElement('li');
  li.textContent = msg;
  translationEl.appendChild(li);
  translationEl.scrollTop = translationEl.scrollHeight;
});

// If arrived via a QR link with ?id=, join Telugu automatically.
if (urlId) joinService(urlId, langSelect.value);
