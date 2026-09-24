import { clipboard } from 'electron';
import { ClipboardFilter } from './ClipboardFilter';
import { ClipboardDetector } from './ClipboardDetector';
import { clipboardHistory, ClipboardHistory } from './ClipboardHistory';
import { makeClipboardItem } from './ClipboardUtils';
import { CLIPBOARD_DETECTED, CLIPBOARD_STARTED, CLIPBOARD_STOPPED } from './ClipboardEvents';
import { DEFAULT_CLIPBOARD_SETTINGS } from './ClipboardSettings';
import { v4 as uuidv4 } from 'uuid';
import { getSettings } from '../store';

export class ClipboardManager {
  private timer: NodeJS.Timeout | null = null;
  private lastText = '';
  private paused = false;
  private cooldownUntil = 0;
  private history: ClipboardHistory = clipboardHistory;

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), 700);
    this.emit(CLIPBOARD_STARTED, { started: true });
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.emit(CLIPBOARD_STOPPED, { stopped: true });
    }
  }

  pause() { this.paused = true; }
  resume() { this.paused = false; }

  toggle() { this.paused = !this.paused; }

  getStatus() {
    return {
      running: !!this.timer,
      paused: this.paused,
      lastText: this.lastText
    };
  }

  getHistory() { return this.history.list(); }
  clearHistory() { this.history.clear(); }

  private emit(event: string, payload: any) {
    // send via global IPC channel from main process; main will wire to windows
    // we expose a simple global function that main imports and uses to send events
    // main will supply `onClipboardEvent` hook to call
    if ((global as any).__clipboardEventHook) {
      try { (global as any).__clipboardEventHook(event, payload); } catch (e) { /* ignore */ }
    }
  }

  private poll() {
    try {
      if (this.paused) return;
      const settings = getSettings();
      const cbSettings = (settings as any).clipboardSettings || DEFAULT_CLIPBOARD_SETTINGS;
      // ignore images
      if (ClipboardFilter.clipboardHasImage()) return;
      const text = clipboard.readText();
      if (!text || typeof text !== 'string') return;
      const normalized = text.replace(/\s+/g, ' ').trim();
      if (!normalized) return;

      const now = Date.now();
      if (this.cooldownUntil && now < this.cooldownUntil) return;

      if (ClipboardFilter.shouldIgnoreText(normalized)) return;

      if (normalized === this.lastText) return; // duplicate

      // classify
      const detectedType = ClipboardDetector.detectType(normalized);

      const item = makeClipboardItem(normalized, detectedType, 'system');
      this.history.add(item);

      // enforce cooldown
      this.cooldownUntil = Date.now() + (cbSettings.cooldownSeconds || DEFAULT_CLIPBOARD_SETTINGS.cooldownSeconds) * 1000;
      this.lastText = normalized;

      // emit event
      this.emit(CLIPBOARD_DETECTED, { item });
    } catch (e) {
      // safe-fail
      console.warn('ClipboardManager poll error', e);
    }
  }
}

export const clipboardManager = new ClipboardManager();
