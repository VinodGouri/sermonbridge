// Live English -> Telugu (and other languages) sermon translation server.
//
// Flow:
//   speaker page  --(English chunks via Web Speech API or Deepgram)-->  this server
//   this server   --(group chunks into sentences, translate)-->  listener phones
//
// Rooms (Socket.io):
//   `${serviceCode}:transcript`  -> raw English transcript
//   `${serviceCode}:${lang}`     -> translation for that language
//
// Sentence-aware delivery: speech arrives as short chunks cut by pauses, not by
// sentences. Translating each chunk alone loses context. So the server groups
// chunks into one growing sentence per service. Listeners first see a quick DRAFT
// translation that grows as more chunks arrive, which is then replaced by the
// FINAL translation of the whole sentence once it ends or the speaker pauses.

import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import QRCode from 'qrcode';
import { translateText } from './translate.js';
import { DeepgramSession } from './deepgram.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VIEWS_DIR = path.join(__dirname, '..', 'views');

const PORT = process.env.PORT || 3000;
const SPEAKER_KEY = process.env.SPEAKER_KEY || '';

// How long the speaker must be quiet before a sentence is finalized.
const PAUSE_MS = Number(process.env.PAUSE_MS) || 1500;
// Force a finalize after this many words so a long sentence never stalls.
const MAX_WORDS = Number(process.env.MAX_WORDS) || 45;
// How many earlier sentences are passed to the translator as background context.
const CONTEXT_SENTENCES = 3;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e7 }); // 10 MB for audio chunks

app.use(express.static(PUBLIC_DIR));

// Listener page is the default. Speaker control page lives at /speak.
app.get('/', (req, res) => res.sendFile(path.join(VIEWS_DIR, 'listen.html')));
app.get('/listen', (req, res) => res.sendFile(path.join(VIEWS_DIR, 'listen.html')));
app.get('/speak', (req, res) => res.sendFile(path.join(VIEWS_DIR, 'speak.html')));

// Remove spoken filler ("uh", "um") so listeners do not get lines like "And, uh,".
const FILLER = /\b(?:uh+|um+|uhm+|erm?|hmm+)\b,?/gi;
function cleanTranscript(text) {
  return text
    .replace(FILLER, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.?!;:])/g, '$1')
    .replace(/^[\s,.;:]+/, '')
    .trim();
}

// QR code (SVG) that encodes the listener join link for a given service code.
app.get('/qr', async (req, res) => {
  const id = String(req.query.id || '').trim();
  if (!id) return res.status(400).send('missing id');
  const joinUrl = `${req.protocol}://${req.get('host')}/listen?id=${encodeURIComponent(id)}`;
  try {
    const svg = await QRCode.toString(joinUrl, { type: 'svg', margin: 1, width: 240 });
    res.type('svg').send(svg);
  } catch (err) {
    res.status(500).send('qr error');
  }
});

// Short language links such as /te?id=4821 open the listener page in that language.
// Defined after /qr, /speak and /listen so those keep working.
app.get('/:lang([a-z]{2,3})', (req, res) => res.sendFile(path.join(VIEWS_DIR, 'listen.html')));

// Which languages are currently being listened to for a service, derived from
// the Socket.io rooms, so we only spend translation calls on languages that
// actually have someone listening.
function activeLanguagesFor(serviceCode) {
  const prefix = `${serviceCode}:`;
  const langs = new Set();
  for (const roomName of io.sockets.adapter.rooms.keys()) {
    if (roomName.startsWith(prefix)) {
      const lang = roomName.slice(prefix.length);
      if (lang && lang !== 'transcript') langs.add(lang);
    }
  }
  return [...langs];
}

// ---------------------------------------------------------------------------
// Sentence buffer, one per service code
// ---------------------------------------------------------------------------
const sessions = new Map();

function getSession(code) {
  let s = sessions.get(code);
  if (!s) {
    s = { nextId: 1, id: 0, rev: 0, text: '', timer: null, history: [], cache: new Map(), lastUsed: Date.now() };
    s.id = s.nextId++;
    sessions.set(code, s);
  }
  s.lastUsed = Date.now();
  return s;
}

const wordCount = (t) => t.trim().split(/\s+/).filter(Boolean).length;
const endsSentence = (t) => /[.?!]["')\]]?$/.test(t.trim());

// Translate a snapshot of the sentence for every listening language and emit it.
// `snap` is captured before any await, so new speech arriving meanwhile cannot
// change what this call sends.
async function publish(code, snap, rev, final) {
  const langs = activeLanguagesFor(code);
  await Promise.all(langs.map(async (lang) => {
    let text;
    if (lang === 'en') {
      text = snap.source;
    } else {
      const hit = snap.cache.get(lang);
      if (hit && hit.source === snap.source) {
        text = hit.text; // the draft already translated exactly this text
      } else {
        try {
          text = await translateText(snap.source, lang, snap.context);
          snap.cache.set(lang, { source: snap.source, text });
        } catch (err) {
          console.error(`translate error [${lang}]: ${err.message}`);
          return;
        }
      }
    }
    io.to(`${code}:${lang}`).emit('translation', { id: snap.id, rev, source: snap.source, text, final });
  }));
}

function snapshot(s) {
  return { id: s.id, source: s.text, cache: s.cache, context: s.history.slice(-CONTEXT_SENTENCES) };
}

// Close the current sentence: send its final translation and start a fresh one.
function finalize(code) {
  const s = sessions.get(code);
  if (!s || !s.text) return;
  clearTimeout(s.timer);
  s.timer = null;
  const snap = snapshot(s);
  const rev = ++s.rev;
  // Reset synchronously so chunks that arrive during translation start a new sentence.
  s.history.push(s.text);
  if (s.history.length > 20) s.history.shift();
  s.id = s.nextId++;
  s.text = '';
  s.cache = new Map();
  publish(code, snap, rev, true).catch((e) => console.error('publish error', e));
}

function addChunk(code, chunk) {
  const s = getSession(code);
  s.text = s.text ? `${s.text} ${chunk}` : chunk;
  clearTimeout(s.timer);

  if (endsSentence(s.text) || wordCount(s.text) >= MAX_WORDS) {
    finalize(code);
    return;
  }
  // Quick draft now, final after the speaker pauses.
  publish(code, snapshot(s), ++s.rev, false).catch((e) => console.error('publish error', e));
  s.timer = setTimeout(() => finalize(code), PAUSE_MS);
}

// Drop buffers for services that have been idle for a while.
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [code, s] of sessions) {
    if (!s.text && s.lastUsed < cutoff) sessions.delete(code);
  }
}, 10 * 60 * 1000).unref();

io.on('connection', (socket) => {
  // Listener joins/leaves a language (or transcript) room.
  socket.on('join', (room) => { if (typeof room === 'string') socket.join(room); });
  socket.on('leave', (room) => { if (typeof room === 'string') socket.leave(room); });

  // Speaker sends a chunk of English (a phrase between pauses).
  socket.on('transcriptReady', ({ serviceCode, transcript, speakerKey } = {}) => {
    if (!serviceCode || typeof transcript !== 'string' || !transcript.trim()) return;
    if (SPEAKER_KEY && speakerKey !== SPEAKER_KEY) return; // reject unauthorized speakers

    const text = cleanTranscript(transcript);
    if (!/[\p{L}\p{N}]/u.test(text)) return; // nothing left after removing filler
    if (/^(and|but|so|then|well|now|the|a)\W*$/i.test(text)) return; // lone connector fragment

    io.to(`${serviceCode}:transcript`).emit('transcript', text);
    addChunk(String(serviceCode), text);
  });

  // ---------------------------------------------------------------------------
  // Deepgram live STT – browser streams raw audio → server → Deepgram
  // ---------------------------------------------------------------------------
  let dgSession = null;

  socket.on('deepgram:start', async ({ serviceCode, speakerKey, language } = {}) => {
    if (!serviceCode) return;
    if (SPEAKER_KEY && speakerKey !== SPEAKER_KEY) return;

    // Tear down any previous session for this socket.
    if (dgSession) { dgSession.close(); dgSession = null; }

    try {
      dgSession = new DeepgramSession({
        language: language || 'en-IN',
        onTranscript: (transcript, isFinal) => {
          if (!isFinal) return;  // only feed final transcripts into the pipeline
          const text = cleanTranscript(transcript);
          if (!/[\p{L}\p{N}]/u.test(text)) return;
          if (/^(and|but|so|then|well|now|the|a)\W*$/i.test(text)) return;

          io.to(`${serviceCode}:transcript`).emit('transcript', text);
          addChunk(String(serviceCode), text);
          // Echo back to the speaker page for display.
          socket.emit('deepgram:transcript', { text, isFinal: true });
        },
        onError: (err) => {
          console.error('[deepgram] error:', err.message || err);
          socket.emit('deepgram:error', { message: String(err.message || err) });
        },
        onClose: () => {
          socket.emit('deepgram:closed');
        },
      });

      await dgSession.start();
      socket.emit('deepgram:ready');
      console.log(`[deepgram] session started for service ${serviceCode}`);
    } catch (err) {
      console.error('[deepgram] start failed:', err.message);
      socket.emit('deepgram:error', { message: err.message });
      dgSession = null;
    }
  });

  socket.on('deepgram:audio', (data) => {
    if (dgSession && data) dgSession.send(Buffer.from(data));
  });

  socket.on('deepgram:stop', () => {
    if (dgSession) { dgSession.close(); dgSession = null; }
  });

  socket.on('disconnect', () => {
    if (dgSession) { dgSession.close(); dgSession = null; }
  });

  // A listener flagged the last line as wrong. For now it is logged so you can
  // review mistranslations (especially doctrinal terms) and extend the glossary.
  socket.on('report', (r = {}) => {
    const clip = (v) => String(v ?? '').slice(0, 500);
    console.log('TRANSLATION_REPORT ' + JSON.stringify({
      at: new Date().toISOString(),
      serviceCode: clip(r.serviceCode), lang: clip(r.lang),
      source: clip(r.source), text: clip(r.text)
    }));
  });
});

server.listen(PORT, () => {
  console.log(`Live translate server running on http://localhost:${PORT}`);
  console.log(`  Speaker control page: http://localhost:${PORT}/speak`);
  console.log(`  Listener page:        http://localhost:${PORT}/listen`);
  console.log(`  Sentence pause: ${PAUSE_MS} ms, max words: ${MAX_WORDS}`);
});
