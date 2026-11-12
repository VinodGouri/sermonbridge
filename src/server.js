// Live English -> Telugu (and other languages) sermon translation server.
//
// Flow:
//   speaker page  --(English transcript via Web Speech API)-->  this server
//   this server   --(translate to each language a listener chose)-->  listener phones
//
// Rooms (Socket.io):
//   `${serviceCode}:transcript`  -> raw English transcript
//   `${serviceCode}:${lang}`     -> translation for that language

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import QRCode from 'qrcode';
import { translateText } from './translate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VIEWS_DIR = path.join(__dirname, '..', 'views');

const PORT = process.env.PORT || 3000;
const SPEAKER_KEY = process.env.SPEAKER_KEY || '';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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

// Which languages are currently being listened to for a service — derived from
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

io.on('connection', (socket) => {
  // Listener joins/leaves a language (or transcript) room.
  socket.on('join', (room) => { if (typeof room === 'string') socket.join(room); });
  socket.on('leave', (room) => { if (typeof room === 'string') socket.leave(room); });

  // Speaker sends a finished line of English.
  socket.on('transcriptReady', async ({ serviceCode, transcript, speakerKey } = {}) => {
    if (!serviceCode || !transcript || !transcript.trim()) return;
    if (SPEAKER_KEY && speakerKey !== SPEAKER_KEY) return; // reject unauthorized speakers

    const text = cleanTranscript(transcript);
    if (!/[\p{L}\p{N}]/u.test(text)) return; // nothing left after removing filler
    if (/^(and|but|so|then|well|now|the|a)\W*$/i.test(text)) return; // lone connector fragment

    // Send the raw English to anyone watching the transcript.
    io.to(`${serviceCode}:transcript`).emit('transcript', text);

    // Translate once per language that has a listener, and fan out. Each
    // message carries the English source so the page can show it under the line.
    const langs = activeLanguagesFor(serviceCode);
    await Promise.all(langs.map(async (lang) => {
      if (lang === 'en') {
        io.to(`${serviceCode}:en`).emit('translation', { source: text, text });
        return;
      }
      try {
        const translated = await translateText(text, lang);
        io.to(`${serviceCode}:${lang}`).emit('translation', { source: text, text: translated });
      } catch (err) {
        console.error(`translate error [${lang}]: ${err.message}`);
      }
    }));
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
});
