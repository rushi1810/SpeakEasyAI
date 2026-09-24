import WebSocket from 'ws';

export interface DeepgramTranscriptEvent {
  text: string;
  isPartial: boolean;
  speechFinal: boolean;
}

export interface DeepgramLiveStartResult {
  success: boolean;
  error?: string;
}

export class DeepgramLiveClient {
  private socket: WebSocket | null = null;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pendingChunks: Buffer[] = [];
  private isReady = false;
  private isStopping = false;
  private apiKey: string | null = null;
  private reconnectAttempt = 0;
  private onTranscript: ((event: DeepgramTranscriptEvent) => void) | null = null;
  private firstAudioChunkSent = false;

  async start(
    apiKey: string,
    onTranscript: (event: DeepgramTranscriptEvent) => void
  ): Promise<DeepgramLiveStartResult> {
    if (!apiKey) {
      return { success: false, error: 'No Deepgram API Key' };
    }

    this.apiKey = apiKey;
    this.onTranscript = onTranscript;
    this.isStopping = false;
    this.firstAudioChunkSent = false;
    this.clearReconnectTimer();

    const params = new URLSearchParams({
      model: 'nova-3',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      smart_format: 'true',
      interim_results: 'true',
      punctuate: 'true',
      vad_events: 'true',
      endpointing: '250',
      utterance_end_ms: '1000'
    });

    return await new Promise((resolve) => {
      const socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${params.toString()}`, {
        headers: {
          Authorization: `Token ${apiKey}`
        }
      });

      let settled = false;
      const finish = (result: DeepgramLiveStartResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const timeout = setTimeout(() => {
        console.error('[DEEPGRAM] Connection timed out while connecting');
        try { socket.terminate(); } catch {}
        finish({ success: false, error: 'Connection timed out' });
      }, 5000);

      socket.on('open', () => {
        clearTimeout(timeout);
        console.log('[DEEPGRAM] WebSocket connected');
        this.socket = socket;
        this.isReady = true;
        this.reconnectAttempt = 0;
        this.keepAliveTimer = setInterval(() => {
          if (this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({ type: 'KeepAlive' }));
          }
        }, 5000);

        for (const chunk of this.pendingChunks.splice(0)) {
          if (chunk.length) {
            this.socket.send(chunk);
          }
        }

        finish({ success: true });
      });

      socket.on('message', (raw: WebSocket.RawData) => {
        try {
          const payload = JSON.parse(raw.toString());
          if (payload.type !== 'Results') return;

          const text = payload.channel?.alternatives?.[0]?.transcript || '';
          if (!text || !text.trim()) return;

          const isPartial = !payload.is_final;
          const speechFinal = Boolean(payload.speech_final);
          console.log(`[DEEPGRAM] ${speechFinal ? 'Final' : 'Interim'} transcript: ${text.trim()}`);
          this.onTranscript?.({
            text,
            isPartial,
            speechFinal
          });
        } catch (error: any) {
          console.error('[DEEPGRAM] Parse error:', error.message);
        }
      });

      socket.on('unexpected-response', (_request, response) => {
        clearTimeout(timeout);
        const chunks: Buffer[] = [];

        response.on('data', chunk => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });

        response.on('end', () => {
          const bodyText = Buffer.concat(chunks).toString('utf8');
          const headerError = Array.isArray(response.headers['dg-error'])
            ? response.headers['dg-error'][0]
            : response.headers['dg-error'];
          const parsedBodyError = extractDeepgramError(bodyText);
          const detail = parsedBodyError || headerError || `HTTP ${response.statusCode}`;

          console.error(`[DEEPGRAM] Connection failed: ${detail}`);
          this.isReady = false;
          finish({ success: false, error: detail });
        });
      });

      socket.on('error', (error: Error) => {
        clearTimeout(timeout);
        console.error('[DEEPGRAM] Socket error:', error.message);
        this.isReady = false;
        if (!settled) {
          finish({ success: false, error: error.message });
        }
      });

      socket.on('close', (code: number, reason: Buffer) => {
        clearTimeout(timeout);
        this.isReady = false;
        this.clearKeepAlive();
        this.socket = null;
        const detail = reason.toString() || `code ${code}`;
        if (!this.isStopping) {
          console.warn(`[DEEPGRAM] Connection closed unexpectedly: ${detail}`);
          this.scheduleReconnect();
        } else {
          console.log('[DEEPGRAM] Connection closed cleanly');
        }

        if (!settled) {
          finish({ success: false, error: detail || `Socket closed (${code})` });
        }
      });
    });
  }

  sendAudio(chunk: Buffer): void {
    if (!chunk || !chunk.length) return;
    const audioChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!audioChunk.length) return;

    if (!this.firstAudioChunkSent) {
      this.firstAudioChunkSent = true;
      console.log(`[DEEPGRAM] First audio chunk sent: ${audioChunk.length} bytes`);
    }

    if (this.isReady && this.socket?.readyState === WebSocket.OPEN) {
      const bufferedAmount = this.socket.bufferedAmount || 0;
      const maxBufferedAmount = 256 * 1024;
      if (bufferedAmount > maxBufferedAmount) {
        if (this.pendingChunks.length < 32) {
          this.pendingChunks.push(audioChunk);
        }
        return;
      }

      this.socket.send(audioChunk);
      return;
    }

    if (this.pendingChunks.length < 32) {
      this.pendingChunks.push(audioChunk);
    }
  }

  getBufferedAmount(): number {
    if (!this.socket) return 0;
    return typeof this.socket.bufferedAmount === 'number' ? this.socket.bufferedAmount : 0;
  }

  async stop(): Promise<void> {
    this.isStopping = true;
    this.isReady = false;
    this.pendingChunks = [];
    this.firstAudioChunkSent = false;
    this.clearKeepAlive();
    this.clearReconnectTimer();
    this.apiKey = null;

    if (!this.socket) return;

    const socket = this.socket;
    this.socket = null;

    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'CloseStream' }));
          socket.close();
        } else {
          socket.terminate();
        }
      } catch {
        resolve();
      }
      setTimeout(resolve, 500);
    });
  }

  private clearKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.apiKey || this.isStopping) return;
    if (this.reconnectTimer) return;

    const backoffMs = Math.min(30000, 1000 * (2 ** this.reconnectAttempt || 1));
    this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 5);
    console.log(`[DEEPGRAM] Reconnecting in ${backoffMs}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.apiKey || this.isStopping) return;
      void this.start(this.apiKey, this.onTranscript ?? (() => undefined)).catch(() => undefined);
    }, backoffMs);
  }
}

function extractDeepgramError(bodyText: string): string | null {
  if (!bodyText) return null;

  try {
    const payload = JSON.parse(bodyText);
    return payload.err_msg || payload.message || null;
  } catch {
    return bodyText.trim() || null;
  }
}
