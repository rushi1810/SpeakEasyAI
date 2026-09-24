// audio-capture.ts
// Manages automatic desktop/system audio capture for interview mode.
// The actual capture is performed by the renderer using Electron desktop
// source constraints so that no microphone stream is ever requested.

import { BrowserWindow } from 'electron';

export class AudioCaptureManager {
  private overlayWindow: BrowserWindow | null = null;
  private isCapturing = false;

  setWindow(win: BrowserWindow): void {
    this.overlayWindow = win;
  }

  private safeSend(channel: string): void {
    if (!this.overlayWindow || this.overlayWindow.isDestroyed()) return;
    const wc = this.overlayWindow.webContents;
    if (wc.isDestroyed()) return;
    try {
      wc.send(channel);
    } catch (error) {
      console.warn(`[SYSTEM-AUDIO] Failed to send ${channel}:`, error);
    }
  }

  startCapture(): void {
    if (this.isCapturing) return;
    this.isCapturing = true;
    console.log('[SYSTEM-AUDIO] Starting desktop audio capture request');
    this.safeSend('start-system-audio-capture');
  }

  stopCapture(): void {
    if (!this.isCapturing) return;
    this.isCapturing = false;
    console.log('[SYSTEM-AUDIO] Stopping desktop audio capture request');
    this.safeSend('stop-system-audio-capture');
  }

  isActive(): boolean {
    return this.isCapturing;
  }
}

export const audioCaptureManager = new AudioCaptureManager();
