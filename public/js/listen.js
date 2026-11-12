// Listener page. Shows each translated line in bold with the English source
// under it, plus read-aloud, stop/resume and report controls.

const socket = io();
const $ = (id) => document.getElementById(id);

const els = {
  menuBtn: $('menuBtn'), menu: $('menu'), langSelect: $('langSelect'),
  sizeDown: $('sizeDown'), sizeUp: $('sizeUp'), showSource: $('showSource'),
  changeCode: $('changeCode'),
  joinPanel: $('joinPanel'), codeInput: $('codeInput'), joinLang: $('joinLang'), joinBtn: $('joinBtn'),
  livePanel: $('livePanel'), stream: $('stream'), shareBtn: $('shareBtn'),
  controls: $('controls'), muteBtn: $('muteBtn'), muteIcon: $('muteIcon'),
  stopBtn: $('stopBtn'), stopIcon: $('stopIcon'), reportBtn: $('reportBtn'),
  toast: $('toast')
};

// --- tiny safe storage helpers (storage can be blocked) ---
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
};

// --- icons ---
const ICON = {
  speakerOff: '<path d="M3 9v6h4l5 4V5L7 9H3z"/><path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/>',
  speakerOn: '<path d="M3 9v6h4l5 4V5L7 9H3z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="1.5"/>',
  play: '<path d="M7 4.5v15l13-7.5z"/>'
};

// --- language lists ---
const validKeys = new Set(window.LANGUAGES.map((l) => l.key));
for (const sel of [els.langSelect, els.joinLang]) {
  for (const lang of window.LANGUAGES) {
    const o = document.createElement('option');
    o.value = lang.key; o.textContent = lang.value; sel.appendChild(o);
  }
}

// --- state: code and language from URL (/te?id=4821 or ?id=&lang=), then storage ---
const params = new URLSearchParams(location.search);
const pathLang = location.pathname.split('/').filter(Boolean)[0];
const urlLang = params.get('lang') || (validKeys.has(pathLang) ? pathLang : null);
let lang = urlLang || store.get('lang') || 'te';
if (!validKeys.has(lang)) lang = 'te';
let code = params.get('id') || store.get('serviceCode') || '';
let currentRoom = null;
let listening = false;
let speakOn = false;
let lastLine = null;
let waitingEl = null;
let dotsEl = null;

els.codeInput.value = code;
els.joinLang.value = lang;
els.langSelect.value = lang;

// --- text size ---
let size = parseFloat(store.get('fs')) || 1.55;
function applySize() {
  document.documentElement.style.setProperty('--fs', size + 'rem');
  store.set('fs', String(size));
}
applySize();
els.sizeUp.addEventListener('click', () => { size = Math.min(2.6, +(size + 0.15).toFixed(2)); applySize(); });
els.sizeDown.addEventListener('click', () => { size = Math.max(1.0, +(size - 0.15).toFixed(2)); applySize(); });

// --- show/hide English ---
const showSrcStored = store.get('showSource');
els.showSource.checked = showSrcStored === null ? true : showSrcStored === '1';
function applySource() {
  els.stream.classList.toggle('src-off', !els.showSource.checked);
  store.set('showSource', els.showSource.checked ? '1' : '0');
}
applySource();
els.showSource.addEventListener('change', applySource);

// --- menu ---
function setMenu(open) {
  els.menu.hidden = !open;
  els.menuBtn.setAttribute('aria-expanded', String(open));
  els.menuBtn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
}
els.menuBtn.addEventListener('click', () => setMenu(els.menu.hidden));
els.langSelect.addEventListener('change', () => {
  lang = els.langSelect.value;
  els.joinLang.value = lang;
  if (code) joinService(code, lang);
  setMenu(false);
});
els.changeCode.addEventListener('click', () => {
  leaveRoom();
  els.livePanel.hidden = true; els.controls.hidden = true; els.joinPanel.hidden = false;
  setMenu(false);
});

// --- toast ---
let toastTimer;
function toast(msg) {
  els.toast.textContent = msg; els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2600);
}

// --- rooms ---
function leaveRoom() {
  if (currentRoom) socket.emit('leave', currentRoom);
  currentRoom = null; listening = false;
}

function joinService(c, l) {
  leaveRoom();
  code = c; lang = l;
  currentRoom = `${code}:${lang}`;
  socket.emit('join', currentRoom);
  listening = true;
  store.set('serviceCode', code); store.set('lang', lang);
  els.langSelect.value = lang;

  els.stream.innerHTML = '';
  lineMap.clear();
  waitingEl = document.createElement('li');
  waitingEl.className = 'waiting';
  waitingEl.textContent = 'Waiting for the speaker to begin…';
  els.stream.appendChild(waitingEl);
  showDots(true);

  els.joinPanel.hidden = true; els.livePanel.hidden = false; els.controls.hidden = false;
  setStopIcon();
}

els.joinBtn.addEventListener('click', () => {
  const c = els.codeInput.value.trim();
  if (!c) { els.codeInput.focus(); return; }
  joinService(c, els.joinLang.value);
});
// Re-join automatically after a connection drop.
socket.on('connect', () => { if (currentRoom && listening) socket.emit('join', currentRoom); });

// --- typing dots (shown at the end while listening) ---
function showDots(on) {
  if (dotsEl && dotsEl.parentNode) dotsEl.parentNode.removeChild(dotsEl);
  dotsEl = null;
  if (!on) return;
  dotsEl = document.createElement('li');
  dotsEl.className = 'dots';
  dotsEl.setAttribute('aria-hidden', 'true');
  dotsEl.innerHTML = '<span></span><span></span><span></span>';
  els.stream.appendChild(dotsEl);
}

// --- add or update a line ---
// The server first sends a DRAFT of a sentence that grows as more speech arrives,
// then the FINAL translation of the whole sentence. All messages for one sentence
// share an `id`; `rev` orders them so a late draft never overwrites a newer one.
const lineMap = new Map(); // id -> { li, tr, src, rev, final }
let anonId = 0;

function showLine(msg) {
  const { id, rev = 0, source = '', text, final = true } = msg;
  if (waitingEl) { waitingEl.remove(); waitingEl = null; }
  const stick = els.stream.scrollHeight - els.stream.scrollTop - els.stream.clientHeight < 140;

  let entry = lineMap.get(id);
  if (!entry) {
    const li = document.createElement('li');
    li.className = 'line';
    const tr = document.createElement('div'); tr.className = 'tr';
    const src = document.createElement('div'); src.className = 'src';
    li.appendChild(tr); li.appendChild(src);
    if (dotsEl && dotsEl.parentNode) els.stream.insertBefore(li, dotsEl);
    else els.stream.appendChild(li);
    entry = { li, tr, src, rev: -1, final: false };
    lineMap.set(id, entry);
    if (lineMap.size > 300) lineMap.delete(lineMap.keys().next().value);
  }

  if (entry.final) return;                  // already settled
  if (!final && rev <= entry.rev) return;   // stale draft that arrived late

  entry.rev = rev;
  entry.final = final;
  entry.tr.textContent = text;
  entry.src.textContent = source;
  entry.li.classList.toggle('draft', !final);

  lastLine = { source, text };
  if (stick) els.stream.scrollTop = els.stream.scrollHeight;
  if (final && speakOn) speak(text);        // read aloud only finished sentences
}
// handy for demos and tests
window.addLine = (l) => showLine({ id: 'demo' + (anonId++), text: l.text, source: l.source, final: true });

socket.on('translation', (msg) => {
  if (!listening) return;
  if (typeof msg === 'string') showLine({ id: 'str' + (anonId++), text: msg });
  else if (msg && typeof msg.text === 'string') {
    showLine(msg.id === undefined ? { ...msg, id: 'u' + (anonId++) } : msg);
  }
});

// --- read aloud (browser speech synthesis) ---
const speechOK = 'speechSynthesis' in window;
function setMuteIcon() {
  els.muteIcon.innerHTML = speakOn ? ICON.speakerOn : ICON.speakerOff;
  els.muteBtn.setAttribute('aria-pressed', String(speakOn));
  els.muteBtn.setAttribute('aria-label', speakOn ? 'Read aloud is on' : 'Read aloud is off');
}
function speak(text) {
  if (!speechOK) return;
  if (window.speechSynthesis.pending) return; // keep up with the speaker; drop stale lines
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang === 'te' ? 'te-IN' : lang;
  window.speechSynthesis.speak(u);
}
els.muteBtn.addEventListener('click', () => {
  if (!speechOK) { toast('Read aloud is not supported on this device'); return; }
  speakOn = !speakOn;
  if (!speakOn) window.speechSynthesis.cancel();
  setMuteIcon();
  toast(speakOn ? 'Read aloud on (needs a voice for this language)' : 'Read aloud off');
});
setMuteIcon();

// --- stop / resume ---
function setStopIcon() {
  els.stopIcon.innerHTML = listening ? ICON.stop : ICON.play;
  els.stopBtn.setAttribute('aria-label', listening ? 'Stop listening' : 'Resume listening');
}
els.stopBtn.addEventListener('click', () => {
  if (listening) {
    leaveRoom(); showDots(false);
    if (speechOK) window.speechSynthesis.cancel();
    toast('Stopped. Press play to resume.');
  } else if (code) {
    const keep = Array.from(els.stream.querySelectorAll('.line'));
    joinService(code, lang);
    keep.forEach((n) => els.stream.insertBefore(n, dotsEl));
    if (keep.length && waitingEl) { waitingEl.remove(); waitingEl = null; }
  }
  setStopIcon();
});

// --- report a problem with the last line ---
els.reportBtn.addEventListener('click', () => {
  if (!lastLine) { toast('Nothing to report yet'); return; }
  socket.emit('report', { serviceCode: code, lang, source: lastLine.source, text: lastLine.text });
  toast('Thanks, we noted that line');
});

// --- share ---
els.shareBtn.addEventListener('click', async () => {
  const url = `${location.origin}/${lang}?id=${encodeURIComponent(code)}`;
  try {
    if (navigator.share) { await navigator.share({ title: 'Live translation', url }); return; }
    await navigator.clipboard.writeText(url);
    toast('Link copied');
  } catch (e) { /* user cancelled or blocked */ }
});

// Arrived with a code in the link: go straight to the live view.
if (params.get('id')) joinService(code, lang);
