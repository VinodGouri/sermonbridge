# Telugu Assembly — Live Sermon Translation

Live English → Telugu (and other languages) for a local assembly. The speaker
talks in English; the browser transcribes it; the server translates each line
and sends it to every listener's phone in the language they chose. No app to
install — listeners just open a link or scan a QR code.

Built as our own, from scratch. Phase 1 uses tools that need **no API keys**.

## How it works

```
Speaker's laptop (Chrome)                 Server (this app)              Listeners' phones
  speaks English                            Socket.io rooms                open /listen
  Web Speech API → text   ──socket──▶       translate per language  ──▶    pick Telugu
                                            (Google Translate, free)        read live
```

- **Speech → text:** the browser's built-in Web Speech API (Chrome). No key.
- **Translation:** `google-translate-api-x` (free). No key.
- **Delivery:** Socket.io rooms, one per `service:language`.

## Requirements

- Node.js 18 or newer
- Google **Chrome** on the speaker's device (Web Speech API)
- Internet connection (for translation)

## Run it locally

```bash
cp .env.example .env     # optional; defaults are fine
npm install
npm start
```

Then:

1. **Speaker** opens `http://localhost:3000/speak` in Chrome, clicks **Start**,
   allows the microphone, and begins speaking English. A 4-digit **service code**
   and a **QR code** appear.
2. **Listeners** open `http://localhost:3000/listen` (or scan the QR), enter the
   code, and choose **తెలుగు (Telugu)**. Translation streams in live.

### Letting phones on the same Wi‑Fi connect

`localhost` only works on the speaker's own machine. For phones on the same
network, find the laptop's local IP (e.g. `192.168.1.20`) and have listeners
open `http://192.168.1.20:3000/listen`. The QR code uses whatever address the
speaker page was opened with, so open the speaker page via that IP too.

> Note: Chrome allows the microphone on `localhost`, but other devices may need
> HTTPS for mic access. The **speaker** is always the laptop on localhost, so
> this is fine; only listeners use other devices, and they don't need a mic.

## Configuration (`.env`)

| Variable               | Meaning                                                        |
|------------------------|----------------------------------------------------------------|
| `PORT`                 | Port to listen on (default 3000)                               |
| `DEFAULT_SERVICE_CODE` | Fix the join code instead of auto-generating one              |
| `SPEAKER_KEY`          | If set, the speaker must enter this key before streaming      |
| `PAUSE_MS`             | Quiet time before a sentence is finalized (default 1500)      |
| `MAX_WORDS`            | Force a sentence to close after this many words (default 45)  |

## How sentences are delivered

Speech arrives in short chunks cut by pauses, not by sentences. The server
groups chunks into one growing sentence per service. Listeners first see a quick
**draft** translation (slightly dimmed) that grows as you keep speaking, which is
replaced in place by the **final** translation of the whole sentence when it ends
or you pause for `PAUSE_MS`. The last few sentences are passed to the translator
as background context; Google's free API ignores it, the Phase 3 AI translator
will use it.

## Roadmap

- **Phase 1 (now):** browser speech recognition + free Google Translate.
- **Phase 2:** swap speech-to-text for **Deepgram** (more robust for long
  services, handles accents better). Only the speaker page changes.
- **Phase 3:** swap translation for an **AI translator** given the
  Brethren-assembly register + `glossary.te.json`, so assembly terms
  (assembly, breaking of bread, saints, the Lord's table…) and Scripture come
  out in the wording the congregation knows. Only `src/translate.js` changes.

`glossary.te.json` is already in the repo as a starter term base for Phase 3.
**It must be reviewed by a native Telugu-speaking elder before relying on it.**
