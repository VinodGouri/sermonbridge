// Deepgram live-transcription bridge.
//
// Each speaker socket gets one DeepgramSession that opens a persistent
// WebSocket to Deepgram's STT service. Raw audio from the browser
// (via getUserMedia + ScriptProcessor → socket.io binary) is forwarded
// straight to Deepgram. When Deepgram returns a transcript, the callback
// fires so server.js can feed it into the sentence-buffer / translation pipeline.

import { DeepgramClient } from '@deepgram/sdk';

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || '';

export class DeepgramSession {
  /**
   * @param {object} opts
   * @param {string}   opts.language   BCP-47 code, e.g. 'en-IN'
   * @param {function} opts.onTranscript  called with (transcriptString, isFinal)
   * @param {function} [opts.onError]     called with (Error)
   * @param {function} [opts.onClose]     called when the DG connection closes
   */
  constructor({ language = 'en-IN', onTranscript, onError, onClose } = {}) {
    this._language = language;
    this._onTranscript = onTranscript || (() => {});
    this._onError = onError || ((e) => console.error('[deepgram]', e));
    this._onClose = onClose || (() => {});
    this._socket = null;
    this._open = false;
    this._keepAliveTimer = null;
    this._closed = false;
  }

  /** Open the connection to Deepgram. Returns a promise that resolves once ready. */
  async start() {
    if (!DEEPGRAM_API_KEY) {
      throw new Error('DEEPGRAM_API_KEY is not set. Add it to your .env file.');
    }

    const deepgram = new DeepgramClient({ apiKey: DEEPGRAM_API_KEY });

    // createConnection returns a Promise that resolves to the socket object.
    this._socket = await deepgram.listen.v1.createConnection({
      model: 'nova-3',
      language: this._language.split('-')[0], // Deepgram wants 'en', not 'en-IN'
      smart_format: true,
      punctuate: true,
      interim_results: true,
      utterance_end_ms: 1500,
      vad_events: true,
      encoding: 'linear16',
      sample_rate: 16000,
      channels: 1,
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this._open) {
          this._cleanup();
          reject(new Error('Deepgram connection timed out after 10 s'));
        }
      }, 10000);

      this._socket.on('open', () => {
        this._open = true;
        clearTimeout(timeout);
        console.log('[deepgram] WebSocket open');

        // Deepgram drops connections with code 1000 after ~5 seconds if no audio or keepAlive is received.
        // The SDK's sendKeepAlive requires { type: 'KeepAlive' } to be passed in, otherwise it sends undefined.
        // We ping every 2 seconds to ensure the connection stays alive even through pauses in speech.
        this._keepAliveTimer = setInterval(() => {
          if (this._socket && this._open) {
            try {
              this._socket.sendKeepAlive({ type: 'KeepAlive' });
            } catch (_) { /* ignore */ }
          }
        }, 2000);

        resolve();
      });

      this._socket.on('message', (data) => {
        // Deepgram sends Results (transcripts) and Metadata messages.
        if (data.type === 'Results' && data.channel?.alternatives?.[0]) {
          const transcript = data.channel.alternatives[0].transcript;
          if (transcript) {
            const isFinal = !!data.is_final;
            this._onTranscript(transcript, isFinal);
          }
        }
      });

      this._socket.on('error', (err) => {
        console.error('[deepgram] WebSocket error:', err);
        clearTimeout(timeout);
        if (!this._open) {
          reject(typeof err === 'object' && err.message ? err : new Error(String(err)));
        } else {
          this._onError(typeof err === 'object' && err.message ? err : new Error(String(err)));
        }
      });

      this._socket.on('close', () => {
        console.log('[deepgram] WebSocket closed');
        this._open = false;
        this._cleanup();
        if (!this._closed) this._onClose();
      });

      // Initiate the WebSocket connection.
      this._socket.connect();
    });
  }

  /** Send a chunk of raw audio (Buffer or Uint8Array). */
  send(audioData) {
    if (this._socket && this._open) {
      try {
        this._socket.sendMedia(audioData);
      } catch (err) {
        console.error('[deepgram] sendMedia error:', err.message);
      }
    }
  }

  /** Gracefully close the Deepgram connection. */
  close() {
    this._closed = true;
    if (this._socket && this._open) {
      try { this._socket.sendCloseStream(); } catch (_) { /* ignore */ }
      setTimeout(() => {
        try { this._socket.close(); } catch (_) { /* ignore */ }
      }, 500);
    } else if (this._socket) {
      try { this._socket.close(); } catch (_) { /* ignore */ }
    }
    this._cleanup();
  }

  _cleanup() {
    if (this._keepAliveTimer) {
      clearInterval(this._keepAliveTimer);
      this._keepAliveTimer = null;
    }
    this._open = false;
  }
}
