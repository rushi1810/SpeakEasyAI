import {
  app, BrowserWindow, ipcMain, screen, session,
  desktopCapturer, globalShortcut, shell, clipboard, dialog
} from 'electron';
import * as path from 'path';
import { APP_ROOT, KBD_DIR, JD_DIR, RESUME_DIR, SESSIONS_DIR, LOGS_DIR } from './main/paths';
import {
  initializeApplicationFolders,
  getKbdDirectory,
  getJdDirectory,
  getResumeDirectory,
  getSessionsDirectory,
  saveKbdFile,
  listKbdFiles,
  deleteKbdFile,
  saveJdFile,
  listJdFiles,
  deleteJdFile,
  saveResumeFile,
  listResumeFiles,
  deleteResumeFile,
  saveSessionRecord,
  listSessions,
  deleteSessionRecord,
  getLogsDirectory,
  isSafeAppPath
} from './main/folderManager';

// --- PDF-PARSE MOCKS (for libraries that expect browser-like globals) ---
if (typeof (global as any).DOMMatrix === 'undefined') {
  (global as any).DOMMatrix = class {};
}
if (typeof (global as any).ImageData === 'undefined') {
  (global as any).ImageData = class {};
}
if (typeof (global as any).Path2D === 'undefined') {
  (global as any).Path2D = class {};
}
import { v4 as uuidv4 } from 'uuid';
import { clipboardManager } from './clipboard/ClipboardManager';
import {
  getCachedModelCatalog, getSettings, saveSettings, getSessions, saveSession,
  SessionRecord, TranscriptEntry, AIConversationEntry, SessionKbdActivityRecord, SessionQuestionRecord
} from './store';
import {
  initGroq, generateAnswerStream, analyzeScreenContent,
  detectQuestionInTranscript, validateApiKey,
  isGroqInitialized
} from './groq';
import type { AnswerIntent, AnswerStyle } from './groq';
import { aiModelManager } from './ai/ModelManager';
import { transcribeWithGroq } from './stt-service';
import { audioCaptureManager } from './audio-capture';
import { documentProcessor } from './document-processor';
import { embeddingService } from './embedding-service';
import { retrievalService } from './retrieval-service';
import { KBDExactMatch, kbdExactMatchService } from './kbd-exact-match-service';
import { kbdRetrievalService } from './kbd-retrieval-service';
import { sqlKnowledgeService, SqlDirectAnswer } from './sql-knowledge-service';
import { DeepgramLiveClient } from './deepgram-live';
import * as fs from 'fs-extra';
import * as nativeFs from 'fs';
import type { DocumentSource } from './knowledge-types';

const OVERLAY_BAR_WIDTH = 900;         // landscape interview bar width
const OVERLAY_BAR_WIDTH_PORTRAIT = 700; // portrait interview bar width
const AI_PANEL_HEIGHT = 900;
const AI_PANEL_ATTACH_OVERLAP = 0;
// Setup screen sizes
const SETUP_W_LANDSCAPE = 520;
const SETUP_H_LANDSCAPE = 640;
const SETUP_W_PORTRAIT  = 420;
const SETUP_H_PORTRAIT  = 680;
const APP_ID = 'com.speakeasyai.app';
const SCREEN_ANALYSIS_CAPTURE_WIDTH = 1280;
const SCREEN_ANALYSIS_CAPTURE_HEIGHT = 720;
const SCREEN_ANALYSIS_JPEG_QUALITY = 60;

interface ResolvedAnswerRequest {
  question?: string;
  isCoding: boolean;
  answerIntent: AnswerIntent;
  answerStyle: AnswerStyle;
  wantsExample: boolean;
  wantsSteps: boolean;
  followUpContext?: string;
  previousAnswerContext?: string;
  dedupeKey?: string;
}

function resolveAssetPath(fileName: string): string {
  return path.join(app.getAppPath(), 'assets', fileName);
}

function resolveRendererPath(fileName: string): string {
  return path.join(app.getAppPath(), 'renderer', fileName);
}

function resolveContentFolder(source: 'resume' | 'jd' | 'kb'): string {
  switch (source) {
    case 'resume':
      return getResumeDirectory();
    case 'jd':
      return getJdDirectory();
    case 'kb':
    default:
      return getKbdDirectory();
  }
}

const STARTUP_ERROR_MESSAGE = `SpeakEasy AI could not initialize its local storage.\n\nRequired location:\nC:\\SpeakEasy AI\\\n\nPlease check your Windows permissions or disk availability.`;

// ─── App State ───────────────────────────────────────────────────────────────

class GroqInterviewApp {
  private overlayWindow: BrowserWindow | null = null;
  private settingsWindow: BrowserWindow | null = null;
  private isInterviewMode = false;
  private isCollapsed = false;
  private currentSession: SessionRecord | null = null;
  private sessionTimer: NodeJS.Timeout | null = null;
  private sessionElapsed = 0;
  private isAIStreaming = false;
  private currentStreamText = '';
  private transcriptBuffer: TranscriptEntry[] = [];
  private autoAnswerTimeout: NodeJS.Timeout | null = null;
  private lastTranscriptTime = 0;
  private lastAutoAnswerKey = '';
  private lastAutoAnswerAt = 0;
  private lastAnsweredTranscriptAt = 0;
  private pendingAutoAnswerAfterStream = false;
  private isClickThrough = false;
  private currentLayout: 'landscape' | 'portrait' = 'landscape';
  private deepgramLiveClient = new DeepgramLiveClient();
  private kbWatcher: nativeFs.FSWatcher | null = null;
  private kbWatcherDebounce: NodeJS.Timeout | null = null;
  private sqlDatasetWatcher: nativeFs.FSWatcher | null = null;
  private sqlDatasetWatcherDebounce: NodeJS.Timeout | null = null;
  private aiMetricListenerRegistered = false;

  focusMainWindow(): void {
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      this.overlayWindow.show();
      this.overlayWindow.focus();
      return;
    }

    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
      this.settingsWindow.show();
      this.settingsWindow.focus();
    }
  }

  private attachWindowDiagnostics(window: BrowserWindow, name: string): void {
    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      console.error(`[${name}] Failed to load ${validatedURL}: ${errorCode} ${errorDescription}`);
    });

    window.webContents.on('render-process-gone', (_event, details) => {
      try {
        console.error(`[${name}] Renderer process exited:`, {
          reason: details?.reason,
          exitCode: (details as any)?.exitCode,
          wasKilled: (details as any)?.wasKilled
        });
      } catch (e) {
        console.error(`[${name}] Renderer process exited (unable to read details):`, e);
      }

      // Perform clean shutdown of any renderer-dependent timers and services
      try {
        this.handleRendererGone(details);
      } catch (e) {
        console.error('[Main] Error while handling renderer gone cleanup:', e);
      }
    });

    // Forward renderer console messages to main logs for easier debugging
    window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      try {
        console.log(`[${name}][console:${level}] ${message} (${sourceId}:${line})`);
      } catch (e) {
        console.log(`[${name}][console] ${message}`);
      }
    });
  }

  private safeSendToOverlay(channel: string, payload?: any): void {
    try {
      const win = this.overlayWindow;
      if (!win || win.isDestroyed()) return;
      const wc = win.webContents;
      if (!wc || wc.isDestroyed()) return;
      wc.send(channel, payload);
    } catch (err) {
      // If send fails because the renderer is gone, ensure we don't repeatedly try to send
      console.warn(`[Main] Failed to send ${channel}:`, err && (err as any).message ? (err as any).message : String(err));
    }
  }

  private selectScreenSource(sources: Electron.DesktopCapturerSource[]): Electron.DesktopCapturerSource | undefined {
    if (!sources.length) return undefined;

    const targetDisplay = this.overlayWindow
      ? screen.getDisplayMatching(this.overlayWindow.getBounds())
      : screen.getPrimaryDisplay();
    const targetDisplayId = String(targetDisplay.id);

    return sources.find(source => source.display_id === targetDisplayId) || sources[0];
  }

  private prepareScreenAnalysisImage(source: Electron.DesktopCapturerSource): {
    base64: string;
    mimeType: string;
    width: number;
    height: number;
    byteLength: number;
  } {
    const thumbnail = source.thumbnail;
    if (thumbnail.isEmpty()) {
      throw new Error('Captured screen thumbnail is empty');
    }

    const originalSize = thumbnail.getSize();
    const widthScale = SCREEN_ANALYSIS_CAPTURE_WIDTH / Math.max(originalSize.width, 1);
    const heightScale = SCREEN_ANALYSIS_CAPTURE_HEIGHT / Math.max(originalSize.height, 1);
    const resizeScale = Math.min(widthScale, heightScale, 1);
    const targetWidth = Math.max(1, Math.round(originalSize.width * resizeScale));
    const targetHeight = Math.max(1, Math.round(originalSize.height * resizeScale));

    const resized = resizeScale < 0.999
      ? thumbnail.resize({
          width: targetWidth,
          height: targetHeight,
          quality: 'good'
        })
      : thumbnail;
    const finalImage = resized.isEmpty() ? thumbnail : resized;
    const finalSize = finalImage.getSize();
    const jpegBuffer = finalImage.toJPEG(SCREEN_ANALYSIS_JPEG_QUALITY);

    return {
      base64: jpegBuffer.toString('base64'),
      mimeType: 'image/jpeg',
      width: finalSize.width,
      height: finalSize.height,
      byteLength: jpegBuffer.length
    };
  }

  // ── Window creation ──────────────────────────────────────────────────────

  createOverlayWindow(): void {
    aiModelManager.loadCachedCatalog(getCachedModelCatalog());
    const settings = getSettings();
    this.currentLayout = settings.windowLayout || 'landscape';

    // Clamp initial size to 90% of work area
    const { workAreaSize } = screen.getPrimaryDisplay();
    const maxH = Math.floor(workAreaSize.height * 0.92);

    const isPortrait = this.currentLayout === 'portrait';
    const initW = isPortrait ? SETUP_W_PORTRAIT : SETUP_W_LANDSCAPE;
    const initH = Math.min(isPortrait ? SETUP_H_PORTRAIT : SETUP_H_LANDSCAPE, maxH);

    this.overlayWindow = new BrowserWindow({
      width: initW,
      height: initH,
      minWidth: 360,
      minHeight: 200,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: true,
      movable: true,
      focusable: true,
      icon: resolveAssetPath('icon.ico'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    // Content Protection (Anti-Screen Sharing)
    // We will also apply this in ready-to-show for better reliability on Windows
    if (settings.contentProtection) {
      const success = this.overlayWindow.setContentProtection(true);
      console.log(`[Main] Initial Content Protection applied: ${success}`);
    }

    // Position window
    this.positionWindow(settings.windowPosition);

    // Native setOpacity breaks background transparency on frameless windows in Windows.
    // Opacity will be exclusively handled via CSS on rendering side.

    // Load renderer
    this.attachWindowDiagnostics(this.overlayWindow, 'overlay');
    this.overlayWindow.once('ready-to-show', () => {
      this.overlayWindow?.show();
      // Re-apply/Verify protection after show for Windows layered window compatibility
      const currentSettings = getSettings();
      if (currentSettings.contentProtection) {
        const success = this.overlayWindow?.setContentProtection(true);
        console.log(`[Main] Content Protection verified on show: ${success}`);
      }
    });
    this.overlayWindow.loadFile(resolveRendererPath('index.html'));

    // Initialize Groq if API key exists
    if (settings.groqApiKey) {
      initGroq(settings.groqApiKey);
      void this.refreshAIModels().finally(() => {
        void this.indexLocalFolders();
      });
    } else {
      // Auto-index existing files from local folders
      this.indexLocalFolders();
    }

    audioCaptureManager.setWindow(this.overlayWindow);

    this.overlayWindow.on('closed', () => {
      this.overlayWindow = null;
      app.quit();
    });

    // Detect manual user resize — notify renderer so it can pause auto-resize
    let userResizeDebounce: NodeJS.Timeout | null = null;
    this.overlayWindow.on('will-resize', () => {
      this.safeSendToOverlay('user-resize-start');
      if (userResizeDebounce) clearTimeout(userResizeDebounce);
      userResizeDebounce = setTimeout(() => {
        this.safeSendToOverlay('user-resize-end');
        userResizeDebounce = null;
      }, 3000); // resume auto-resize 3s after last manual drag
    });

  }

  private async refreshAIModels(): Promise<void> {
    const catalog = await aiModelManager.refreshModels();
    console.log('AI Models: refreshed catalog', {
      chat: catalog.chat.length,
      vision: catalog.vision.length,
      speech: catalog.speech.length,
      agent: catalog.agent.length,
      source: catalog.source,
      error: catalog.error
    });
    this.safeSendToOverlay('ai-models-updated', catalog);
    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
      try { this.settingsWindow.webContents.send('ai-models-updated', catalog); } catch (err) { console.warn('[Main] Failed to send AI models update:', err); }
    }
  }

  private registerAIMetricForwarder(): void {
    if (this.aiMetricListenerRegistered) return;
    this.aiMetricListenerRegistered = true;
    aiModelManager.on('metric', metric => {
      this.safeSendToOverlay('ai-metric', metric);
      if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
        try { this.settingsWindow.webContents.send('ai-metric', metric); } catch (err) { console.warn('[Main] Failed to send AI metric:', err); }
      }
    });
  }

  async indexLocalFolders(): Promise<void> {
    const visionModel = aiModelManager.getVisionModel();
    const folders: Array<{ path: string; source: DocumentSource }> = [
      { path: resolveContentFolder('resume'), source: 'resume' },
      { path: resolveContentFolder('jd'), source: 'jd' },
      { path: resolveContentFolder('kb'), source: 'kb' }
    ];

    console.log('RAG: Starting auto-indexing of local folders...');
    for (const folder of folders) {
      try {
        await fs.ensureDir(folder.path);
        const files = await fs.readdir(folder.path);
        for (const file of files) {
          const filePath = path.join(folder.path, file);
          const stats = await fs.stat(filePath);
          if (stats.isFile()) {
            console.log(`RAG: Auto-indexing ${file} as ${folder.source}`);
            try {
              const processed = await documentProcessor.processFile(filePath, folder.source, {
                allowImageOcr: true,
                visionModel
              });
              await embeddingService.addDocument(processed.text, processed.source, processed.fileName);
            } catch (err) {
              console.warn(`RAG: Failed to index ${file}:`, err);
            }
          }
        }
      } catch (err) {
        console.warn(`RAG: Folder ${folder.path} not ready:`, err);
      }
    }
    console.log('RAG: Auto-indexing complete.');
    await kbdExactMatchService.warmCache(true);
    console.log('KBD Exact Match: Cache warmed.');

    await this.indexSqlDataset();
    this.watchKBDExactMatchFolder();
    this.watchSqlDatasetFolder();
  }

  private async indexSqlDataset(force = false): Promise<void> {
    try {
      const status = await sqlKnowledgeService.indexDataset(force);
      if (status.available) {
        console.log(`SQL Dataset: Indexed ${status.indexedDocuments} documents (${status.indexedChunks} chunks).`);
        if (status.pendingOcrFiles > 0) {
          console.log(`SQL Dataset: ${status.pendingOcrFiles} image files are waiting for OCR.`);
        }
      } else {
        console.log(`SQL Dataset: Folder not found at ${status.rootPath}`);
      }
    } catch (error) {
      console.warn('SQL Dataset: Failed to index dataset:', error);
    }
  }

  private watchKBDExactMatchFolder(): void {
    if (this.kbWatcher) return;

    const folder = resolveContentFolder('kb');
    try {
      this.kbWatcher = nativeFs.watch(folder, () => {
        if (this.kbWatcherDebounce) clearTimeout(this.kbWatcherDebounce);
        this.kbWatcherDebounce = setTimeout(() => {
          void kbdExactMatchService.warmCache(true)
            .then(() => {
              console.log('KBD Exact Match: Cache refreshed.');
              this.safeSendToOverlay('kbd-updated', { source: 'watcher', timestamp: Date.now() });
            })
            .catch(err => console.warn('KBD Exact Match: Cache refresh failed:', err));
        }, 250);
      });
    } catch (err) {
      console.warn('KBD Exact Match: Watcher could not start:', err);
    }
  }

  private watchSqlDatasetFolder(): void {
    if (this.sqlDatasetWatcher) return;

    const folder = sqlKnowledgeService.resolveDatasetRoot();
    if (!nativeFs.existsSync(folder)) return;

    try {
      this.sqlDatasetWatcher = nativeFs.watch(folder, { recursive: true }, () => {
        if (this.sqlDatasetWatcherDebounce) clearTimeout(this.sqlDatasetWatcherDebounce);
        this.sqlDatasetWatcherDebounce = setTimeout(() => {
          void this.indexSqlDataset();
        }, 500);
      });
    } catch (err) {
      console.warn('SQL Dataset: Watcher could not start:', err);
    }
  }


  createSettingsWindow(): void {
    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
      this.settingsWindow.focus();
      return;
    }

    this.settingsWindow = new BrowserWindow({
      width: 560,
      height: 680,
      minWidth: 400,
      minHeight: 480,
      show: false,
      frame: false,
      transparent: false,
      alwaysOnTop: true,
      resizable: true,
      movable: true,
      icon: resolveAssetPath('icon.ico'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    this.attachWindowDiagnostics(this.settingsWindow, 'settings');
    this.settingsWindow.once('ready-to-show', () => {
      this.settingsWindow?.show();
    });
    this.settingsWindow.loadFile(resolveRendererPath('settings.html'));

    this.settingsWindow.on('closed', () => {
      this.settingsWindow = null;
    });
  }

  // ── Window positioning ──────────────────────────────────────────────────

  positionWindow(position: string): void {
    if (!this.overlayWindow) return;
    const display = screen.getDisplayMatching(this.overlayWindow.getBounds());
    const { x: waX, y: waY, width, height } = display.workArea;
    const [winW, winH] = this.overlayWindow.getSize();
    const margin = 12;
    const positions: Record<string, { x: number; y: number }> = {
      'top-left':      { x: waX + margin, y: waY + margin },
      'top-center':    { x: waX + Math.floor((width - winW) / 2), y: waY + margin },
      'top-right':     { x: waX + width - winW - margin, y: waY + margin },
      'bottom-left':   { x: waX + margin, y: waY + height - winH - margin },
      'bottom-center': { x: waX + Math.floor((width - winW) / 2), y: waY + height - winH - margin },
      'bottom-right':  { x: waX + width - winW - margin, y: waY + height - winH - margin }
    };
    const pos = positions[position] || positions['top-center'];
    this.overlayWindow.setPosition(
      Math.max(waX, Math.min(pos.x, waX + width - winW)),
      Math.max(waY, Math.min(pos.y, waY + height - winH))
    );
  }

  private clampHeightToScreen(desiredH: number): number {
    if (!this.overlayWindow) return desiredH;
    const display = screen.getDisplayMatching(this.overlayWindow.getBounds());
    return Math.min(desiredH, Math.floor(display.workArea.height * 0.94));
  }


  private getRecentTranscriptEntries(limit = 5, afterTimestamp = 0): TranscriptEntry[] {
    return this.transcriptBuffer
      .filter(entry => entry.timestamp > afterTimestamp)
      .slice(-limit);
  }

  getRecentTranscriptText(limit = 5, afterTimestamp = 0): string {
    return this.getRecentTranscriptEntries(limit, afterTimestamp)
      .map(entry => entry.text.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private getLatestTranscriptTimestamp(): number {
    return this.transcriptBuffer.length
      ? this.transcriptBuffer[this.transcriptBuffer.length - 1].timestamp
      : 0;
  }

  private advanceTranscriptCursor(timestamp: number): void {
    if (!timestamp) return;
    this.lastAnsweredTranscriptAt = Math.max(this.lastAnsweredTranscriptAt, timestamp);
    this.transcriptBuffer = this.transcriptBuffer.filter(entry => entry.timestamp > this.lastAnsweredTranscriptAt);
  }

  private async sendRelatedKbdQuestions(question: string): Promise<void> {
    const cleanQuestion = (question || '').replace(/\s+/g, ' ').trim();
    if (!cleanQuestion) return;

    const results = await kbdRetrievalService.getRelatedQuestions(cleanQuestion, 8);
    this.safeSendToOverlay('kbd-related-questions', {
      query: cleanQuestion,
      results: results.map(item => ({
        id: item.id,
        question: item.question,
        answer: item.answer,
        fileName: item.fileName,
        score: Number(item.score || 0)
      })),
      timestamp: Date.now()
    });
  }

  private ensureSessionKbdActivity(session: SessionRecord): SessionKbdActivityRecord[] {
    if (!Array.isArray(session.kbdActivity)) {
      session.kbdActivity = [];
    }
    return session.kbdActivity;
  }

  private recordSessionKbdActivity(
    session: SessionRecord,
    activity: Omit<SessionKbdActivityRecord, 'id' | 'timestamp'>
  ): void {
    if (!session) return;
    this.ensureSessionKbdActivity(session).push({
      ...activity,
      id: uuidv4(),
      timestamp: Date.now()
    });
    saveSession(session);
  }

  private buildSessionText(session: SessionRecord): string {
    const endMs = session.endTime ?? Date.now();
    const start = new Date(session.startTime);
    const end = new Date(endMs);
    const durationSeconds = Math.max(0, Math.floor((endMs - session.startTime) / 1000));
    const formatDuration = (seconds: number): string => {
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return `${mins}m ${secs}s`;
    };

    const lines: string[] = [
      '==================================================',
      'SPEAKEASY AI - INTERVIEW SESSION',
      '==================================================',
      '',
      `Company Name: ${session.company || 'N/A'}`,
      `Position: ${session.position || 'N/A'}`,
      `Session Date: ${start.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}`,
      `Session Start: ${start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`,
      `Session End: ${end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`,
      `Session Duration: ${formatDuration(durationSeconds)}`,
      '',
      '==================================================',
      'JOB DESCRIPTION',
      '==================================================',
      '',
      session.jdText?.trim() || 'No JD text was captured for this session.',
      '',
      '==================================================',
      'INTERVIEW SESSION',
      '==================================================',
      ''
    ];

    if (session.questions && session.questions.length) {
      session.questions.forEach((item, index) => {
        lines.push('--------------------------------------------------');
        lines.push(`QUESTION ${index + 1}`);
        lines.push('--------------------------------------------------');
        lines.push('');
        if (item.rawTranscript) lines.push(`Raw STT: ${item.rawTranscript}`);
        if (item.normalizedTranscript) lines.push(`Normalized Transcript: ${item.normalizedTranscript}`);
        if (item.correctedQuestion) lines.push(`Corrected / Interpreted Question: ${item.correctedQuestion}`);
        if (item.canonicalKbdQuestion) lines.push(`Canonical KBD Question: ${item.canonicalKbdQuestion}`);
        if (item.kbdRecordId) lines.push(`KBD Record ID: ${item.kbdRecordId}`);
        if (Array.isArray(item.relatedKbdQuestions) && item.relatedKbdQuestions.length) {
          lines.push('Related KBD Questions:');
          item.relatedKbdQuestions.forEach((related, idx) => {
            lines.push(`${idx + 1}. ${related.question}${typeof related.score === 'number' ? ` (${related.score.toFixed(2)})` : ''}`);
          });
        }
        if (item.selectedKbdQuestion) lines.push(`Selected KBD Question: ${item.selectedKbdQuestion}`);
        if (item.kbdAnswer) lines.push(`KBD Answer: ${item.kbdAnswer}`);
        if (item.aiAnswer) lines.push(`AI Answer: ${item.aiAnswer}`);
        lines.push('');
      });
    } else if (session.aiConversations && session.aiConversations.length) {
      session.aiConversations.forEach((entry, index) => {
        lines.push('--------------------------------------------------');
        lines.push(`QUESTION ${index + 1}`);
        lines.push('--------------------------------------------------');
        lines.push('');
        lines.push(`Question: ${entry.question}`);
        lines.push(`AI Answer: ${entry.answer}`);
        lines.push('');
      });
    }

    lines.push('==================================================');
    lines.push('FULL TRANSCRIPT');
    lines.push('==================================================');
    lines.push('');

    if (session.transcript && session.transcript.length) {
      session.transcript.forEach(entry => {
        const stamp = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
        lines.push(`[${stamp}] ${entry.text}`);
      });
    } else {
      lines.push('No transcript captured.');
    }

    if (session.kbdActivity && session.kbdActivity.length) {
      lines.push('');
      lines.push('==================================================');
      lines.push('KBD ACTIVITY');
      lines.push('==================================================');
      lines.push('');
      session.kbdActivity.forEach((entry) => {
        const stamp = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
        if (entry.type === 'manual-search') {
          lines.push(`[${stamp}] Manual KBD search: ${entry.term || entry.query || 'unknown query'}`);
        } else if (entry.type === 'selection') {
          lines.push(`[${stamp}] Selected KBD question: ${entry.question || 'unknown question'} (${entry.kbdRecordId || 'unknown id'})`);
        } else {
          lines.push(`[${stamp}] Automatic KBD suggestion for: ${entry.query || entry.question || 'unknown question'}`);
        }
      });
    }

    lines.push('');
    lines.push('==================================================');
    lines.push('SESSION END');
    lines.push('==================================================');
    lines.push('');

    return lines.join('\n');
  }

  private async saveSessionToDisk(session: SessionRecord): Promise<{ success: boolean; path?: string; error?: string }> {
    try {
      const sessionsDir = getSessionsDirectory();
      await fs.ensureDir(sessionsDir);

      const now = new Date(session.startTime || Date.now());
      const baseName = `Session_${now.toISOString().slice(0, 10)}_${now.toTimeString().slice(0, 8).replace(/:/g, '-')}`;
      let fileName = `${baseName}.txt`;
      let filePath = path.join(sessionsDir, fileName);
      let counter = 1;
      while (await fs.pathExists(filePath)) {
        fileName = `${baseName}_${counter}.txt`;
        filePath = path.join(sessionsDir, fileName);
        counter += 1;
      }

      await fs.writeFile(filePath, this.buildSessionText(session), 'utf8');
      return { success: true, path: filePath };
    } catch (error: any) {
      return { success: false, error: error?.message || 'Session file write failed' };
    }
  }

  private normalizeTranscriptKey(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private hasQuestionCue(text: string): boolean {
    return /\b(can you|could you|would you|will you|tell me about|walk me through|explain|describe|what|why|how|when|where|who|which|implement|design|build|write|debug|suppose|imagine|compare)\b/i.test(text);
  }

  private isIntroductionQuestion(text: string): boolean {
    return /\b(introduce yourself|tell me about yourself|tell us about yourself|brief me about yourself|brief about yourself|brief your self|brief myself|walk me through your background|give me a quick intro|share your background|background about yourself)\b/i.test(text);
  }

  private isBehavioralQuestion(text: string): boolean {
    return /\b(tell me about a time|describe a time|give me an example|example of when|situation where|how did you handle|challenge|conflict|failure|mistake|leadership|proud|achievement|accomplishment|strength|weakness)\b/i.test(text);
  }

  private isSystemDesignQuestion(text: string): boolean {
    return /\b(system design|design a|architecture|distributed system|scalability|throughput|availability|latency|partitioning|load balancer|cache|queue|pubsub|rate limit|microservice)\b/i.test(text);
  }

  private isComparisonQuestion(text: string): boolean {
    return /\b(compare|difference between|vs\b|versus|trade[-\s]?off|pros and cons)\b/i.test(text);
  }

  private isPracticalQuestion(text: string): boolean {
    return this.isBehavioralQuestion(text)
      || /\b(have you (worked|used|built|handled|deployed|optimized)|what have you done|tell me about (a project|your project|an experience)|walk me through (a project|what you built)|experience with|worked on|built|implemented|delivered|owned)\b/i.test(text);
  }

  private isScenarioQuestion(text: string): boolean {
    return /\b(what would you do|how would you handle|how would you approach|how would you design|suppose|imagine|let'?s say|if you had to|what if|in a situation where|if .* happens)\b/i.test(text);
  }

  private isProblemSolvingQuestion(text: string): boolean {
    return /\b(debug|debugging|bug|issue|incident|failure|root cause|troubleshoot|outage|resolve|fix|latency|performance|optimi[sz]e|bottleneck|slow query|memory leak|error)\b/i.test(text);
  }

  private isCodingQuestion(text: string): boolean {
    return /\b(code|coding|algorithm|complexity|function|class|array|string|linked list|tree|graph|sql|query|database|implement|debug|bug|binary|stack|queue|api|json|regex|schema|system design|design)\b/i.test(text);
  }

  private isLikelyInterruptedFragment(text: string): boolean {
    const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!normalized) return true;
    if (this.isFollowUpPrompt(normalized)) return false;

    const words = normalized.split(/\s+/).filter(Boolean);
    if (/[?]$/.test(normalized) && this.hasQuestionCue(normalized) && words.length >= 2) {
      return false;
    }
    if (words.length < 4) return true;
    if (/[,:-]$/.test(normalized)) return true;
    if (/\b(and|or|but|because|to|for|of|with|about|on|in|at|from|by|the|a|an|your|my|our|their|this|that|these|those|if|when|while|where)\s*$/i.test(normalized)) {
      return true;
    }

    return false;
  }

  private hasStrongQuestionBoundary(text: string): boolean {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized || this.isLikelyInterruptedFragment(normalized)) return false;

    const words = normalized.split(/\s+/).filter(Boolean);
    if (/[?]$/.test(normalized)) return true;
    if (this.isIntroductionQuestion(normalized) || this.isBehavioralQuestion(normalized)) return true;
    if ((this.isComparisonQuestion(normalized) || this.isScenarioQuestion(normalized) || this.isProblemSolvingQuestion(normalized)) && words.length >= 5) {
      return true;
    }

    return Boolean(/[.!]$/.test(normalized) && this.hasQuestionCue(normalized) && words.length >= 6);
  }

  private getRequiredListeningPauseMs(): number {
    return Math.max(getSettings().autoAnswerDelay * 1000, 2000);
  }

  private isIgnorableTranscript(text: string): boolean {
    const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!normalized || normalized.length > 48) return false;
    if (this.hasQuestionCue(normalized) || /[?]/.test(normalized)) return false;

    return /^(okay|ok|right|alright|yeah|yes|sure|cool|got it|understood|sounds good|thank you|thanks|please continue|go on|carry on|next|next question|moving on)$/.test(normalized);
  }

  private isFollowUpPrompt(text: string): boolean {
    const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!normalized) return false;

    return /^(why|how|what about|what if|and\b|also\b|can you elaborate|elaborate|explain more|expand on that|go deeper|in simple terms|briefly|short answer|with example|any example|trade[-\s]?offs?|pros and cons|complexity|time complexity|space complexity|edge cases?|use cases?|real[-\s]?world example)/.test(normalized);
  }

  private inferFollowUpQuestion(transcript: string): string | undefined {
    const normalized = transcript.replace(/\s+/g, ' ').trim();
    if (!normalized || normalized.length > 90) return undefined;
    if (!this.getLatestAIConversation()) return undefined;

    const cleaned = normalized
      .replace(/^(and|so|then|okay|ok|right|now|next)\s+/i, '')
      .trim();

    if (!this.isFollowUpPrompt(cleaned)) return undefined;
    return cleaned.endsWith('?') ? cleaned : `${cleaned}?`;
  }

  private getLatestAIConversation(): AIConversationEntry | undefined {
    const conversations = this.currentSession?.aiConversations;
    return conversations?.length ? conversations[conversations.length - 1] : undefined;
  }

  private inferAnswerIntent(text: string, isCoding: boolean, hasFollowUpContext: boolean): AnswerIntent {
    const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (this.isSystemDesignQuestion(normalized)) return 'system_design';
    if (this.isComparisonQuestion(normalized)) return 'comparison';
    if (this.isScenarioQuestion(normalized)) return 'scenario_based';
    if (this.isProblemSolvingQuestion(normalized) && !isCoding) return 'problem_solving';
    if (isCoding) return 'coding';
    if (this.isPracticalQuestion(normalized) || (hasFollowUpContext && this.isPracticalQuestion(normalized))) return 'practical';
    return 'conceptual';
  }

  private inferAnswerStyle(text: string, isCoding: boolean, intent: AnswerIntent, hasFollowUpContext: boolean): AnswerStyle {
    const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();

    if (isCoding && /\b(write|implement|code|query|json|sql|function|algorithm|fix|debug|complete|return json|write a program)\b/.test(normalized)) {
      return 'code';
    }

    if (/\b(short|brief|briefly|quick|quickly|concise|in short|one line|two lines|few words|summary|summarize|tldr)\b/.test(normalized)) {
      return 'concise';
    }

    if (/\b(elaborate|explain more|expand|in detail|detailed|deep dive|thoroughly|step by step|walk me through)\b/.test(normalized)) {
      return 'detailed';
    }

    if (hasFollowUpContext && normalized.split(/\s+/).length <= 6) {
      return 'concise';
    }

    return 'standard';
  }

  private buildResolvedAnswerRequest(
    question: string | undefined,
    transcriptContext: string,
    forcedCoding = false
  ): ResolvedAnswerRequest {
    const normalizedQuestion = (question || '').replace(/\s+/g, ' ').trim();
    const normalizedTranscript = transcriptContext.replace(/\s+/g, ' ').trim();
    const latestConversation = this.getLatestAIConversation();

    const followUpQuestion = normalizedQuestion
      ? undefined
      : this.inferFollowUpQuestion(normalizedTranscript);

    const finalQuestion = normalizedQuestion || followUpQuestion || '';
    const attachFollowUpContext = Boolean(
      latestConversation &&
      (this.isFollowUpPrompt(finalQuestion) || (!normalizedQuestion && Boolean(followUpQuestion)))
    );
    const followUpContext = attachFollowUpContext ? latestConversation?.question : undefined;
    const previousAnswerContext = attachFollowUpContext ? latestConversation?.answer : undefined;
    const signalText = `${finalQuestion} ${normalizedTranscript}`.trim();
    const isCoding = forcedCoding || this.isCodingQuestion(signalText);
    const answerIntent = this.inferAnswerIntent(signalText || normalizedTranscript, isCoding, Boolean(followUpContext));
    const wantsExample = /\b(example|use case|scenario|sample|real[-\s]?world)\b/i.test(signalText);
    const wantsSteps = /\b(step by step|walk me through|workflow|process|flow|how exactly)\b/i.test(signalText);
    const answerStyle = this.inferAnswerStyle(signalText || normalizedTranscript, isCoding, answerIntent, Boolean(followUpContext));
    const dedupeKey = finalQuestion
      ? [followUpContext, finalQuestion, answerIntent, answerStyle].filter(Boolean).join(' // ')
      : undefined;

    return {
      question: finalQuestion || undefined,
      isCoding,
      answerIntent,
      answerStyle,
      wantsExample,
      wantsSteps,
      followUpContext,
      previousAnswerContext,
      dedupeKey
    };
  }

  inferQuestionFromTranscript(transcript: string): { question?: string; isCoding: boolean } {
    const normalized = transcript.replace(/\s+/g, ' ').trim();
    if (!normalized) return { isCoding: false };

    const sentenceMatches = normalized.match(/[^.?!]+[?]/g);
    let candidate = sentenceMatches?.length
      ? sentenceMatches[sentenceMatches.length - 1].trim()
      : '';

    if (!candidate) {
      const cueMatches = Array.from(normalized.matchAll(/\b(can you|could you|would you|will you|tell me about|walk me through|explain|describe|what|why|how|when|where|who|which|implement|design|build|write|debug|suppose|imagine|compare)\b/gi));
      const lastCue = cueMatches.length ? cueMatches[cueMatches.length - 1] : undefined;
      if (lastCue?.index !== undefined) {
        candidate = normalized.slice(lastCue.index).trim();
      }
    }

    candidate = candidate
      .replace(/^(and|so|then|okay|ok|right|now|next)\s+/i, '')
      .replace(/[.]+$/, '')
      .trim();

    if (candidate.length < 12 || !this.hasQuestionCue(candidate)) {
      return { isCoding: false };
    }

    const isCoding = /\b(code|coding|algorithm|complexity|function|class|array|string|linked list|tree|graph|sql|query|database|implement|debug|bug|binary|stack|queue|api|system design|design)\b/i.test(candidate);

    return {
      question: candidate.endsWith('?') ? candidate : `${candidate}?`,
      isCoding
    };
  }

  shouldTriggerAutoAnswer(question: string, signature?: string): boolean {
    const key = (signature || question)
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!key) return false;

    const now = Date.now();
    const isDuplicate = key === this.lastAutoAnswerKey && now - this.lastAutoAnswerAt < 90000;
    if (isDuplicate) return false;

    this.lastAutoAnswerKey = key;
    this.lastAutoAnswerAt = now;
    return true;
  }

  private isLikelyCompleteAutoQuestion(transcript: string, candidate?: string): boolean {
    const normalizedTranscript = transcript.replace(/\s+/g, ' ').trim();
    const normalizedCandidate = candidate?.replace(/\s+/g, ' ').trim() || '';

    if (!normalizedTranscript || !normalizedCandidate) return false;

    const candidateWords = normalizedCandidate.split(/\s+/).filter(Boolean);
    if (candidateWords.length < 4) return false;

    if (/[?]/.test(normalizedTranscript)) {
      return true;
    }

    if (/[.!]/.test(normalizedTranscript)) {
      return candidateWords.length >= 5;
    }

    if (!this.hasQuestionCue(normalizedCandidate) || candidateWords.length < 6) {
      return false;
    }

    if (/\b(and|or|to|for|of|with|about|on|in|at|from|into|by|the|a|an|your|my|our|their|this|that|these|those)\s*$/i.test(normalizedCandidate)) {
      return false;
    }

    return candidateWords.length >= 7;
  }

  private async resolveQuestionForAnswer(
    explicitQuestion: string,
    transcriptContext: string,
    model: string,
    trigger: 'manual' | 'screen' | 'auto',
    forcedCoding = false
  ): Promise<ResolvedAnswerRequest> {
    const directQuestion = explicitQuestion.replace(/\s+/g, ' ').trim();
    if (directQuestion) {
      return this.buildResolvedAnswerRequest(directQuestion, transcriptContext, forcedCoding);
    }

    const inferred = this.inferQuestionFromTranscript(transcriptContext);
    if (inferred.question) {
      return this.buildResolvedAnswerRequest(inferred.question, transcriptContext, forcedCoding || inferred.isCoding);
    }

    const followUpQuestion = this.inferFollowUpQuestion(transcriptContext);
    if (followUpQuestion) {
      return this.buildResolvedAnswerRequest(followUpQuestion, transcriptContext, forcedCoding);
    }

    if (!transcriptContext || transcriptContext.length < 15) {
      return this.buildResolvedAnswerRequest(undefined, transcriptContext, forcedCoding || inferred.isCoding);
    }

    const detected = await detectQuestionInTranscript(transcriptContext, model);
    if (detected.isQuestion && detected.question) {
      return this.buildResolvedAnswerRequest(
        detected.question.trim(),
        transcriptContext,
        forcedCoding || Boolean(detected.isCoding ?? inferred.isCoding)
      );
    }

    return this.buildResolvedAnswerRequest(undefined, transcriptContext, forcedCoding || inferred.isCoding);
  }

  // ── Session management ──────────────────────────────────────────────────

  async startSession(options: { company: string; position: string; resume: string; jdText: string; customInstructions: string }): Promise<string> {
    const settings = getSettings();

    // Save session context to store
    saveSettings({
      company: options.company,
      position: options.position,
      resume: options.resume,
      customInstructions: options.customInstructions
    });

    // If JD text is provided manually, index it in background
    if (options.jdText) {
      embeddingService.clearSource('jd')
        .then(() => embeddingService.addDocument(options.jdText, 'jd', 'Manual_JD_Input'))
        .catch(err => console.error('RAG: Failed to index manual JD:', err));
    }

    this.currentSession = {
      id: uuidv4(),
      company: options.company,
      position: options.position,
      startTime: Date.now(),
      transcript: [],
      aiConversations: [],
      jdText: options.jdText || '',
      questions: [],
      kbdActivity: []
    };

    this.transcriptBuffer = [];
    this.lastAutoAnswerKey = '';
    this.lastAutoAnswerAt = 0;
    this.lastAnsweredTranscriptAt = 0;
    this.pendingAutoAnswerAfterStream = false;
    this.sessionElapsed = 0;
    this.isInterviewMode = true;

    // Start timer
    this.sessionTimer = setInterval(() => {
      this.sessionElapsed++;
      this.safeSendToOverlay('session-timer-update', this.sessionElapsed);
    }, 1000);

    // Start mic capture
    audioCaptureManager.startCapture();

    this.safeSendToOverlay('mode-changed', { mode: 'interview' });

    return this.currentSession.id;
  }

  async endSession(): Promise<{ success: boolean; path?: string; message?: string; error?: string }> {
    if (!this.currentSession) {
      return { success: false, error: 'No active interview session to save.' };
    }

    const session = { ...this.currentSession, endTime: Date.now() } as SessionRecord;

    if (this.sessionTimer) {
      clearInterval(this.sessionTimer);
      this.sessionTimer = null;
    }

    audioCaptureManager.stopCapture();
    void this.deepgramLiveClient.stop();
    this.isInterviewMode = false;

    if (this.autoAnswerTimeout) {
      clearTimeout(this.autoAnswerTimeout);
      this.autoAnswerTimeout = null;
    }

    saveSession(session);
    const fileResult = await this.saveSessionToDisk(session);
    if (!fileResult.success) {
      this.currentSession = session;
      this.safeSendToOverlay('toast', { msg: `Session save failed: ${fileResult.error || 'Unknown file error'}` });
      return { success: false, error: fileResult.error || 'Session file write failed' };
    }

    this.currentSession = null;
    this.transcriptBuffer = [];
    this.lastAutoAnswerKey = '';
    this.lastAutoAnswerAt = 0;
    this.lastAnsweredTranscriptAt = 0;
    this.pendingAutoAnswerAfterStream = false;

    this.safeSendToOverlay('mode-changed', { mode: 'dashboard' });
    this.safeSendToOverlay('toast', { msg: `Session saved: ${path.basename(fileResult.path || 'session.txt')}` });
    return { success: true, path: fileResult.path, message: 'Session saved successfully.' };
  }

  // ── AI Answer Generation ─────────────────────────────────────────────────

  async generateAnswer(
    question: string,
    isCoding = false,
    trigger: 'manual' | 'screen' | 'auto' = 'manual',
    preResolved?: ResolvedAnswerRequest
  ): Promise<void> {
    if (this.isAIStreaming) return;

    const settings = getSettings();
    const chatModel = aiModelManager.getChatModel();
    const freshTranscriptContext = this.getRecentTranscriptText(10, this.lastAnsweredTranscriptAt);
    let transcriptContext = freshTranscriptContext || this.getRecentTranscriptText(10);
    const resolved = preResolved || await this.resolveQuestionForAnswer(
      question,
      transcriptContext,
      chatModel,
      trigger,
      isCoding
    );
    const resolvedQuestion = resolved.question?.trim();

    if (!resolvedQuestion) {
      this.safeSendToOverlay('toast', { msg: 'No clear interview question detected yet.' });
      return;
    }

    void this.sendRelatedKbdQuestions(resolvedQuestion);
    if (this.currentSession) {
      const questions = this.currentSession.questions ?? [];
      const existingIndex = questions.findIndex(item => item.question === resolvedQuestion);
      const sessionQuestion: SessionQuestionRecord = {
        id: uuidv4(),
        question: resolvedQuestion,
        rawTranscript: transcriptContext,
        normalizedTranscript: transcriptContext.replace(/\s+/g, ' ').trim(),
        correctedQuestion: resolvedQuestion,
        canonicalKbdQuestion: resolvedQuestion,
        relatedKbdQuestions: [],
        selectedKbdQuestion: resolvedQuestion,
        aiAnswer: '',
        timestamp: Date.now()
      };
      if (existingIndex >= 0) {
        questions[existingIndex] = { ...questions[existingIndex], ...sessionQuestion, id: questions[existingIndex].id };
      } else {
        questions.push(sessionQuestion);
      }
      this.currentSession.questions = questions;
    }

    this.isAIStreaming = true;
    this.currentStreamText = '';
    if (trigger !== 'screen') {
      this.advanceTranscriptCursor(this.getLatestTranscriptTimestamp());
    }
    if (this.autoAnswerTimeout) {
      clearTimeout(this.autoAnswerTimeout);
      this.autoAnswerTimeout = null;
    }

    try {
      this.sendToAIPanel({
        type: 'new-response',
        question: resolvedQuestion,
        sourceStamp: 'Source: Preparing answer...'
      });

      const exactKnowledgeBaseMatch = await kbdExactMatchService.findExactMatch(resolvedQuestion);
      if (exactKnowledgeBaseMatch) {
        this.sendExactKnowledgeBaseAnswer(resolvedQuestion, exactKnowledgeBaseMatch, trigger, true);
        return;
      }


      if (sqlKnowledgeService.isSqlQuestion(resolvedQuestion)) {
        const directSqlAnswer = await sqlKnowledgeService.findDirectAnswer(resolvedQuestion);
        if (directSqlAnswer) {
          this.sendDirectSqlAnswer(resolvedQuestion, directSqlAnswer, trigger, true);
          return;
        }
      }

      // --- RAG RETRIEVAL ---
      console.log('RAG: Retrieving context for query:', resolvedQuestion);
      const context = await retrievalService.retrieveContext(resolvedQuestion);

      const sourceStamp = this.buildGeneratedSourceStamp(context);

      if (!isGroqInitialized()) {
        this.sendToAIPanel({ type: 'error', text: 'Groq API key not configured. Please open Settings.' });
        return;
      }

      this.sendToAIPanel({ type: 'stream-text', text: '', sourceStamp });

      const fullAnswer = await generateAnswerStream({
        question: resolvedQuestion,
        transcript: transcriptContext,
        resumeContext: context.resumeContext,
        jdContext: context.jdContext,
        kbContext: context.kbContext,
        sqlContext: context.sqlContext,
        customInstructions: settings.customInstructions,
        model: chatModel,
        useResumeContext: context.useResumeContext,
        preferKnowledgeBase: context.preferKnowledgeBase,
        preferSqlDataset: context.preferSqlDataset,
        isSqlQuestion: context.isSqlQuestion,
        isCoding: resolved.isCoding,
        answerIntent: resolved.answerIntent,
        answerStyle: resolved.answerStyle,
        wantsExample: resolved.wantsExample,
        wantsSteps: resolved.wantsSteps,
        followUpContext: resolved.followUpContext,
        previousAnswerContext: resolved.previousAnswerContext,
        onReset: () => {
          this.currentStreamText = '';
          this.sendToAIPanel({ type: 'stream-text', text: '', sourceStamp });
        },
        onChunk: (chunk) => {
          this.currentStreamText += chunk;
          this.sendToAIPanel({ type: 'stream-text', delta: chunk });
        }
      });

      // Optionally copy AI answer to clipboard when feature enabled
      try {
        const cbSettings = getSettings().clipboardSettings;
        if (cbSettings && cbSettings.autoCopyAnswer && fullAnswer) {
          clipboard.writeText(fullAnswer);
        }
      } catch (e) {
        console.warn('Failed to auto-copy AI answer to clipboard', e);
      }

      this.sendToAIPanel({ type: 'finalize-response' });

      try {
        const cbSettings = getSettings().clipboardSettings;
        if (cbSettings && cbSettings.autoCopyAnswer && fullAnswer) {
          clipboard.writeText(fullAnswer);
        }
      } catch (e) {
        console.warn('Failed to auto-copy screen analysis answer', e);
      }

      // Save to session
      if (this.currentSession) {
        // Update the session question record with the AI answer
        const sessionQuestion = (this.currentSession.questions ?? []).find(item => item.question === resolvedQuestion || item.correctedQuestion === resolvedQuestion);
        if (sessionQuestion) {
          sessionQuestion.aiAnswer = fullAnswer;
        }
        
        const entry: AIConversationEntry = {
          id: uuidv4(),
          trigger,
          question: resolvedQuestion,
          answer: fullAnswer,
          timestamp: Date.now()
        };
        this.currentSession.aiConversations.push(entry);
        saveSession(this.currentSession);
      }
    } catch (err: any) {
      console.error('AI generation error:', err);
      this.sendToAIPanel({ type: 'error', text: `Error: ${err.message}` });
    } finally {
      this.isAIStreaming = false;
      if (this.pendingAutoAnswerAfterStream && getSettings().autoAnswer) {
        this.pendingAutoAnswerAfterStream = false;
        if (this.autoAnswerTimeout) clearTimeout(this.autoAnswerTimeout);
        this.autoAnswerTimeout = setTimeout(() => {
          void this.checkAutoAnswer();
        }, 300);
      }
    }
  }

  private sendExactKnowledgeBaseAnswer(
    question: string,
    exactKnowledgeBaseMatch: KBDExactMatch,
    trigger: 'manual' | 'screen' | 'auto',
    responseAlreadyOpened = false
  ): void {
    const sourceStamp = `Source: KBD Exact Match - ${exactKnowledgeBaseMatch.fileName} - ${Math.max(80, exactKnowledgeBaseMatch.matchScore)}%`;

    this.currentStreamText = exactKnowledgeBaseMatch.answer;
    if (!responseAlreadyOpened) {
      this.sendToAIPanel({ type: 'new-response', question, sourceStamp });
    }
    this.sendToAIPanel({ type: 'stream-text', text: this.currentStreamText, sourceStamp });
    this.sendToAIPanel({ type: 'finalize-response' });

    try {
      const cbSettings = getSettings().clipboardSettings;
      if (cbSettings && cbSettings.autoCopyAnswer && this.currentStreamText) {
        clipboard.writeText(this.currentStreamText);
      }
    } catch (e) {
      console.warn('Failed to auto-copy KBD answer', e);
    }

    if (this.currentSession) {
      const sessionQuestion = (this.currentSession.questions ?? []).find(item => item.question === question || item.correctedQuestion === question);
      if (sessionQuestion) {
        sessionQuestion.correctedQuestion = exactKnowledgeBaseMatch.matchedQuestion || question;
        sessionQuestion.canonicalKbdQuestion = exactKnowledgeBaseMatch.matchedQuestion || question;
        sessionQuestion.kbdRecordId = exactKnowledgeBaseMatch.recordId || exactKnowledgeBaseMatch.fileName || question;
        sessionQuestion.selectedKbdQuestion = exactKnowledgeBaseMatch.matchedQuestion || question;
        sessionQuestion.kbdAnswer = exactKnowledgeBaseMatch.answer;
        // Also save to aiAnswer if not already set
        if (!sessionQuestion.aiAnswer) {
          sessionQuestion.aiAnswer = exactKnowledgeBaseMatch.answer;
        }
      }

      this.recordSessionKbdActivity(this.currentSession, {
        type: 'selection',
        question: exactKnowledgeBaseMatch.matchedQuestion || question,
        kbdRecordId: exactKnowledgeBaseMatch.recordId || exactKnowledgeBaseMatch.fileName || question,
        source: 'auto',
        score: exactKnowledgeBaseMatch.matchScore / 100,
        query: question
      });

      const entry: AIConversationEntry = {
        id: uuidv4(),
        trigger,
        question,
        answer: exactKnowledgeBaseMatch.answer,
        timestamp: Date.now()
      };
      this.currentSession.aiConversations.push(entry);
      saveSession(this.currentSession);
    }
  }


  private sendDirectSqlAnswer(
    question: string,
    directSqlAnswer: SqlDirectAnswer,
    trigger: 'manual' | 'screen' | 'auto',
    responseAlreadyOpened = false
  ): void {
    const sourceStamp = `Source: SQL Dataset Direct Match - ${directSqlAnswer.fileName} - ${Math.max(80, directSqlAnswer.score)}%`;

    this.currentStreamText = directSqlAnswer.answer;
    if (!responseAlreadyOpened) {
      this.sendToAIPanel({ type: 'new-response', question, sourceStamp });
    }
    this.sendToAIPanel({ type: 'stream-text', text: this.currentStreamText, sourceStamp });
    this.sendToAIPanel({ type: 'finalize-response' });

    try {
      const cbSettings = getSettings().clipboardSettings;
      if (cbSettings && cbSettings.autoCopyAnswer && this.currentStreamText) {
        clipboard.writeText(this.currentStreamText);
      }
    } catch (e) {
      console.warn('Failed to auto-copy SQL answer', e);
    }

    if (this.currentSession) {
      // Update the session question record with the SQL answer
      const sessionQuestion = (this.currentSession.questions ?? []).find(item => item.question === question || item.correctedQuestion === question);
      if (sessionQuestion) {
        sessionQuestion.aiAnswer = directSqlAnswer.answer;
      }
      
      const entry: AIConversationEntry = {
        id: uuidv4(),
        trigger,
        question,
        answer: directSqlAnswer.answer,
        timestamp: Date.now()
      };
      this.currentSession.aiConversations.push(entry);
      saveSession(this.currentSession);
    }
  }

  private buildGeneratedSourceStamp(context: {
    kbContext: string;
    jdContext: string;
    sqlContext: string;
    preferKnowledgeBase: boolean;
    preferSqlDataset: boolean;
    resumeContext: string;
    useResumeContext: boolean;
  }): string {
    if (context.preferSqlDataset && context.sqlContext) {
      return 'Source: AI Generated - SQL dataset-guided';
    }

    if (context.preferKnowledgeBase && context.kbContext) {
      return 'Source: AI Generated - KBD-guided';
    }

    if (context.useResumeContext && context.resumeContext) {
      return 'Source: AI Generated - Resume-guided';
    }

    if (context.jdContext) {
      return 'Source: AI Generated - JD-guided';
    }

    return 'Source: AI Generated - Default';
  }

  async analyzeScreen(): Promise<void> {
    if (this.isAIStreaming) return;
    const settings = getSettings();
    const visionModel = aiModelManager.getVisionModel();
    const chatModel = aiModelManager.getChatModel();

    if (!isGroqInitialized()) {
      this.sendToAIPanel({ type: 'error', text: 'Groq API key not configured. Please open Settings.' });
      return;
    }

    this.isAIStreaming = true;
    this.currentStreamText = '';
    if (this.autoAnswerTimeout) {
      clearTimeout(this.autoAnswerTimeout);
      this.autoAnswerTimeout = null;
    }

    const sourceStamp = 'Source: AI Generated - Screen Analysis';
    this.sendToAIPanel({ type: 'analyzing-screen', sourceStamp });
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: SCREEN_ANALYSIS_CAPTURE_WIDTH,
          height: SCREEN_ANALYSIS_CAPTURE_HEIGHT
        }
      });
      const selectedSource = this.selectScreenSource(sources);

      if (!selectedSource) {
        this.sendToAIPanel({ type: 'error', text: 'Could not capture screen.' });
        return;
      }

      const capture = this.prepareScreenAnalysisImage(selectedSource);
      const transcriptContext = this.getRecentTranscriptText(6);
      console.log('Screen analysis capture prepared:', {
        source: selectedSource.name,
        displayId: selectedSource.display_id,
        width: capture.width,
        height: capture.height,
        bytes: capture.byteLength,
        visionModel,
        chatModel,
        transcriptChars: transcriptContext.length
      });

      this.sendToAIPanel({ type: 'stream-text', text: '', sourceStamp });

      const screenExtraction = await analyzeScreenContent(
        capture.base64,
        visionModel,
        capture.mimeType
      );

      if (!screenExtraction.success) {
        this.sendToAIPanel({
          type: 'error',
          text: screenExtraction.error || 'Could not extract question from the screen.'
        });
        return;
      }

      if (!screenExtraction.question) {
        this.sendToAIPanel({ type: 'no-question' });
        return;
      }

      const extractedQuestion = screenExtraction.question.trim();
      const screenOcrContext = (screenExtraction.ocrText || '').trim();
      const resolved = this.buildResolvedAnswerRequest(
        extractedQuestion,
        [transcriptContext, screenOcrContext].filter(Boolean).join(' '),
        Boolean(screenExtraction.isCoding)
      );
      this.sendToAIPanel({ type: 'update-current-question', question: extractedQuestion });

      const ragQuery = [extractedQuestion, screenOcrContext]
        .filter(Boolean)
        .join('\n\n');
      console.log('RAG: Retrieving context for screen query:', extractedQuestion);
      const context = await retrievalService.retrieveContext(ragQuery);
      const enrichedSourceStamp = `${this.buildGeneratedSourceStamp(context)} + Screen OCR`;
      this.sendToAIPanel({ type: 'stream-text', text: '', sourceStamp: enrichedSourceStamp });

      const fullAnswer = await generateAnswerStream({
        question: extractedQuestion,
        transcript: transcriptContext,
        resumeContext: context.resumeContext,
        jdContext: context.jdContext,
        kbContext: context.kbContext,
        sqlContext: context.sqlContext,
        customInstructions: settings.customInstructions,
        model: chatModel,
        useResumeContext: context.useResumeContext,
        preferKnowledgeBase: context.preferKnowledgeBase,
        preferSqlDataset: context.preferSqlDataset,
        isSqlQuestion: context.isSqlQuestion,
        isCoding: resolved.isCoding,
        answerIntent: resolved.answerIntent,
        answerStyle: resolved.answerStyle,
        wantsExample: resolved.wantsExample,
        wantsSteps: resolved.wantsSteps,
        screenOcrContext,
        onReset: () => {
          this.currentStreamText = '';
          this.sendToAIPanel({ type: 'stream-text', text: '', sourceStamp: enrichedSourceStamp });
        },
        onChunk: (chunk) => {
          this.currentStreamText += chunk;
          this.sendToAIPanel({ type: 'stream-text', delta: chunk, sourceStamp: enrichedSourceStamp });
        }
      });

      if (!fullAnswer) {
        this.sendToAIPanel({ type: 'error', text: 'Screen analysis returned an empty answer.' });
        return;
      }

      this.sendToAIPanel({ type: 'finalize-response' });

      if (this.currentSession) {
        const entry: AIConversationEntry = {
          id: uuidv4(),
          trigger: 'screen',
          question: extractedQuestion,
          answer: fullAnswer,
          timestamp: Date.now()
        };
        this.currentSession.aiConversations.push(entry);
        saveSession(this.currentSession);
      }
    } catch (err: any) {
      console.error('Screen analysis error:', err);
      const message = typeof err?.message === 'string' ? err.message : 'Unexpected screen analysis error';
      this.sendToAIPanel({ type: 'error', text: `Screen analysis failed: ${message}` });
    } finally {
      this.isAIStreaming = false;
      if (this.pendingAutoAnswerAfterStream && getSettings().autoAnswer) {
        this.pendingAutoAnswerAfterStream = false;
        if (this.autoAnswerTimeout) clearTimeout(this.autoAnswerTimeout);
        this.autoAnswerTimeout = setTimeout(() => {
          void this.checkAutoAnswer();
        }, 300);
      }
    }
  }

  // ── Transcript & Auto-answer ─────────────────────────────────────────────

  addTranscriptEntry(
    text: string,
    options: { isPartial?: boolean; speechFinal?: boolean; provider?: string } = {}
  ): void {
    const normalizedText = text.replace(/\s+/g, ' ').trim();
    if (!normalizedText) return;

    const timestamp = Date.now();

    if (options.isPartial) {
      this.safeSendToOverlay('transcript-update', {
        text: normalizedText,
        timestamp,
        isPartial: true,
        provider: options.provider || 'mic'
      });
      this.lastTranscriptTime = timestamp;
      return;
    }

    const dedupeKey = this.normalizeTranscriptKey(normalizedText);
    const lastEntry = this.transcriptBuffer[this.transcriptBuffer.length - 1];
    if (lastEntry && this.normalizeTranscriptKey(lastEntry.text) === dedupeKey) {
      return;
    }

    this.safeSendToOverlay('transcript-update', {
      text: normalizedText,
      timestamp,
      isPartial: false,
      provider: options.provider || 'mic'
    });

    this.lastTranscriptTime = timestamp;

    const entry: TranscriptEntry = {
      id: uuidv4(),
      text: normalizedText,
      timestamp,
      source: 'mic'
    };

    this.transcriptBuffer.push(entry);
    if (this.transcriptBuffer.length > 40) {
      this.transcriptBuffer = this.transcriptBuffer.slice(-40);
    }
    console.log(`STT [${options.provider || 'mic'}]:`, normalizedText);
    if (this.currentSession) {
      this.currentSession.transcript.push(entry);
    }

    // Schedule auto-answer check
    const settings = getSettings();
    if (settings.autoAnswer) {
      if (this.isIgnorableTranscript(normalizedText)) {
        return;
      }

      if (this.isAIStreaming) {
        this.pendingAutoAnswerAfterStream = true;
        return;
      }

      this.scheduleAutoAnswerCheck(options);
    }
  }

  private async tryImmediateKBDAnswer(latestText: string, recentText: string): Promise<boolean> {
    const candidates = Array.from(new Set([latestText, recentText].map(text => text.trim()).filter(Boolean)));

    for (const candidate of candidates) {
      const exactKnowledgeBaseMatch = kbdExactMatchService.findCachedExactMatch(candidate);
      if (exactKnowledgeBaseMatch) {
        const question = exactKnowledgeBaseMatch.matchedQuestion || candidate;
        if (!this.shouldTriggerAutoAnswer(question)) {
          return true;
        }

        if (this.autoAnswerTimeout) {
          clearTimeout(this.autoAnswerTimeout);
          this.autoAnswerTimeout = null;
        }

        this.isAIStreaming = true;
        this.currentStreamText = '';
        try {
          this.advanceTranscriptCursor(this.getLatestTranscriptTimestamp());
          this.sendExactKnowledgeBaseAnswer(question, exactKnowledgeBaseMatch, 'auto');
        } finally {
          this.isAIStreaming = false;
        }

        return true;
      }


    }

    return false;
  }

  private scheduleAutoAnswerCheck(
    options: { speechFinal?: boolean } = {}
  ): void {
    if (this.autoAnswerTimeout) clearTimeout(this.autoAnswerTimeout);

    const recentText = this.getRecentTranscriptText(6, this.lastAnsweredTranscriptAt);
    const latestEntry = this.transcriptBuffer[this.transcriptBuffer.length - 1];
    const inferredQuestion = this.inferQuestionFromTranscript(recentText).question
      || this.inferQuestionFromTranscript(latestEntry?.text || '').question;
    const autoAnswerDelayMs = options.speechFinal && this.hasStrongQuestionBoundary(inferredQuestion || latestEntry?.text || '')
      ? 650
      : this.getRequiredListeningPauseMs();

    this.autoAnswerTimeout = setTimeout(() => {
      void this.checkAutoAnswer();
    }, autoAnswerDelayMs);
  }

  async checkAutoAnswer(): Promise<void> {
    if (this.isAIStreaming) return;

    const recentEntries = this.getRecentTranscriptEntries(6, this.lastAnsweredTranscriptAt);
    const latestEntry = recentEntries.length ? recentEntries[recentEntries.length - 1] : undefined;
    const recentText = recentEntries
      .map(entry => entry.text.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    const idleMs = Date.now() - this.lastTranscriptTime;
    const hasNaturalPause = idleMs >= this.getRequiredListeningPauseMs();

    if (latestEntry && this.isIgnorableTranscript(latestEntry.text) && !this.inferFollowUpQuestion(recentText)) {
      return;
    }

    if ((!latestEntry || latestEntry.text.trim().length < 10) && recentText.length < 15) return;

    const latestInferred = latestEntry ? this.inferQuestionFromTranscript(latestEntry.text) : { isCoding: false };
    let detected: { isQuestion: boolean; question?: string; isCoding?: boolean } = {
      isQuestion: false,
      question: undefined,
      isCoding: undefined
    };
    let inferred = latestInferred;

    if (!latestInferred.question && recentText.length >= 15) {
      detected = await detectQuestionInTranscript(recentText, aiModelManager.getChatModel());
      inferred = this.inferQuestionFromTranscript(recentText);
    }

    const followUpQuestion = latestEntry
      ? this.inferFollowUpQuestion(latestEntry.text) || this.inferFollowUpQuestion(recentText)
      : this.inferFollowUpQuestion(recentText);
    const inferredQuestion = latestInferred.question || inferred.question;
    const canUseInferred = this.isLikelyCompleteAutoQuestion(recentText, inferredQuestion);
    const question = detected.question || (canUseInferred ? inferredQuestion : undefined) || followUpQuestion;
    const isCoding = latestInferred.isCoding || detected.isCoding || inferred.isCoding;
    const resolved = this.buildResolvedAnswerRequest(question, recentText, Boolean(isCoding));
    const hasStrongBoundary = this.hasStrongQuestionBoundary(resolved.question || latestEntry?.text || '');
    const isCompleteQuestion = Boolean(detected.isQuestion || canUseInferred || hasStrongBoundary || followUpQuestion);

    console.log('AUTO: latest entries =>', recentEntries.map(entry => entry.text).join(' | '));
    console.log('AUTO: candidate question =>', resolved.question || '<none>');

    if (!resolved.question) return;
    if (this.isLikelyInterruptedFragment(resolved.question)) return;
    if (!isCompleteQuestion && !hasNaturalPause) return;
    if (!isCompleteQuestion && !this.hasQuestionCue(resolved.question) && !followUpQuestion) return;

    if (await this.tryImmediateKBDAnswer(resolved.question, recentText)) {
      return;
    }

    if (!this.shouldTriggerAutoAnswer(resolved.question, resolved.dedupeKey)) return;

    await this.generateAnswer(resolved.question, resolved.isCoding, 'auto', resolved);
  }

  // ── AI Panel communication ───────────────────────────────────────────────

  sendToAIPanel(message: any): void {
    const json = JSON.stringify(message);
    this.safeSendToOverlay('ai-panel-message', json);
  }

  // Forward arbitrary clipboard events to renderer (serialized)
  public forwardClipboardEvent(channel: string, payload: any): void {
    try {
      const json = JSON.stringify(payload);
      this.safeSendToOverlay(channel, json);
    } catch (e) {
      this.safeSendToOverlay(channel, payload);
    }
  }

  // ── Keyboard shortcuts ───────────────────────────────────────────────────

  registerShortcuts(): void {
    // Ctrl+Enter → AI Answer
    globalShortcut.register('CommandOrControl+Return', () => {
      if (!this.isInterviewMode) return;
      void this.generateAnswer('', false, 'manual');
    });

    // Ctrl+Shift+Enter → Analyze Screen
    globalShortcut.register('CommandOrControl+Shift+Return', () => {
      if (!this.isInterviewMode) return;
      this.analyzeScreen();
    });


    // Ctrl+Shift+C → Collapse/Expand
    globalShortcut.register('CommandOrControl+Shift+C', () => {
      this.toggleCollapse();
    });

    // Ctrl+Shift+X → Toggle Click-through
    globalShortcut.register('CommandOrControl+Shift+X', () => {
      this.setClickThrough(!this.isClickThrough);
    });

    // Ctrl+Shift+T → Toggle near-camera teleprompter
    globalShortcut.register('CommandOrControl+Shift+T', () => {
      if (!this.isInterviewMode) return;
      this.sendToAIPanel({ type: 'toggle-teleprompter' });
    });

    // Esc → Close AI panel
    globalShortcut.register('Escape', () => {
      this.safeSendToOverlay('ai-panel-message', JSON.stringify({ type: 'close-panel' }));
    });

    // --- Window Nudging Shortcuts ---
    // Ctrl + Arrows → 10px Nudge
    globalShortcut.register('CommandOrControl+Up', () => this.nudgeWindow(0, -10));
    globalShortcut.register('CommandOrControl+Down', () => this.nudgeWindow(0, 10));
    globalShortcut.register('CommandOrControl+Left', () => this.nudgeWindow(-10, 0));
    globalShortcut.register('CommandOrControl+Right', () => this.nudgeWindow(10, 0));

    // Ctrl + Alt + Arrows → 1px Precision Nudge
    globalShortcut.register('CommandOrControl+Alt+Up', () => this.nudgeWindow(0, -1));
    globalShortcut.register('CommandOrControl+Alt+Down', () => this.nudgeWindow(0, 1));
    globalShortcut.register('CommandOrControl+Alt+Left', () => this.nudgeWindow(-1, 0));
    globalShortcut.register('CommandOrControl+Alt+Right', () => this.nudgeWindow(1, 0));
  }

  private nudgeWindow(dx: number, dy: number): void {
    if (!this.overlayWindow) return;
    const [x, y] = this.overlayWindow.getPosition();
    this.overlayWindow.setPosition(x + dx, y + dy);
    // Visual feedback
    this.safeSendToOverlay('toast', { msg: `Position: ${x + dx}, ${y + dy}` });
  }

  unregisterShortcuts(): void {
    globalShortcut.unregisterAll();
    if (this.kbWatcherDebounce) {
      clearTimeout(this.kbWatcherDebounce);
      this.kbWatcherDebounce = null;
    }
    if (this.sqlDatasetWatcherDebounce) {
      clearTimeout(this.sqlDatasetWatcherDebounce);
      this.sqlDatasetWatcherDebounce = null;
    }
    this.kbWatcher?.close();
    this.kbWatcher = null;
    this.sqlDatasetWatcher?.close();
    this.sqlDatasetWatcher = null;
  }

  setClickThrough(enabled: boolean): void {
    this.isClickThrough = enabled;
    if (this.overlayWindow) {
      this.overlayWindow.setIgnoreMouseEvents(this.isClickThrough, { forward: true });
      this.safeSendToOverlay('click-through-changed', this.isClickThrough);
    }
  }

  toggleCollapse(): void {
    if (!this.overlayWindow) return;
    this.isCollapsed = !this.isCollapsed;
    this.overlayWindow.setResizable(false);

    if (this.isCollapsed) {
      const [currentW, currentH] = this.overlayWindow.getSize();
      this.overlayWindow.setSize(currentW, currentH);
    } else {
      this.overlayWindow.setResizable(true);
      if (this.isInterviewMode) {
        const barW = this.currentLayout === 'portrait' ? OVERLAY_BAR_WIDTH_PORTRAIT : OVERLAY_BAR_WIDTH;
        const [, h] = this.overlayWindow.getSize();
        this.overlayWindow.setSize(barW, h);
      } else {
        const w = this.currentLayout === 'portrait' ? SETUP_W_PORTRAIT : SETUP_W_LANDSCAPE;
        const h = this.clampHeightToScreen(this.currentLayout === 'portrait' ? SETUP_H_PORTRAIT : SETUP_H_LANDSCAPE);
        this.overlayWindow.setSize(w, h);
      }
    }
    this.safeSendToOverlay('collapse-state-changed', { collapsed: this.isCollapsed });
  }

  toggleLayout(): void {
    if (!this.overlayWindow || this.isCollapsed) return;
    this.currentLayout = this.currentLayout === 'landscape' ? 'portrait' : 'landscape';
    saveSettings({ windowLayout: this.currentLayout });

    if (this.isInterviewMode) {
      const barW = this.currentLayout === 'portrait' ? OVERLAY_BAR_WIDTH_PORTRAIT : OVERLAY_BAR_WIDTH;
      const [, h] = this.overlayWindow.getSize();
      this.overlayWindow.setSize(barW, h);
    } else {
      const w = this.currentLayout === 'portrait' ? SETUP_W_PORTRAIT : SETUP_W_LANDSCAPE;
      const h = this.clampHeightToScreen(this.currentLayout === 'portrait' ? SETUP_H_PORTRAIT : SETUP_H_LANDSCAPE);
      this.overlayWindow.setSize(w, h);
    }

    this.positionWindow(getSettings().windowPosition);
    this.safeSendToOverlay('layout-changed', { layout: this.currentLayout });
  }

  // ── IPC Handlers ─────────────────────────────────────────────────────────

  registerIPC(): void {
    this.registerAIMetricForwarder();

    // Settings
    ipcMain.handle('get-settings', () => getSettings());
    ipcMain.handle('save-settings', async (_, settings) => {
      const normalizedSettings = { ...settings };
      if (typeof normalizedSettings.chatModel === 'string') {
        normalizedSettings.chatModel = aiModelManager.normalizeModelId('chat', normalizedSettings.chatModel);
      }
      if (typeof normalizedSettings.visionModel === 'string') {
        normalizedSettings.visionModel = aiModelManager.normalizeModelId('vision', normalizedSettings.visionModel);
      }
      if (typeof normalizedSettings.speechModel === 'string') {
        normalizedSettings.speechModel = aiModelManager.normalizeModelId('speech', normalizedSettings.speechModel);
      }
      if (typeof normalizedSettings.agentModel === 'string') {
        normalizedSettings.agentModel = aiModelManager.normalizeModelId('agent', normalizedSettings.agentModel);
      }
      saveSettings(normalizedSettings);
      if (normalizedSettings.groqApiKey) {
        initGroq(normalizedSettings.groqApiKey);
        await this.refreshAIModels();
      }
      void this.indexSqlDataset();
      // Opacity is now handled via CSS, but we keep windowOpacity in settings to restore state
      if (normalizedSettings.windowOpacity !== undefined) {
        // We broadcast opacity if we want, or rely on UI to apply it.
      }
      if (normalizedSettings.windowPosition) {
        this.positionWindow(normalizedSettings.windowPosition);
      }
      return { success: true };
    });

    ipcMain.handle('get-ai-models', () => aiModelManager.getModelCatalog());
    ipcMain.handle('refresh-ai-models', async () => {
      await this.refreshAIModels();
      return aiModelManager.getModelCatalog();
    });
    ipcMain.handle('get-ai-metrics', () => aiModelManager.getMetrics());

    ipcMain.handle('validate-api-key', async (_, apiKey) => {
      return validateApiKey(apiKey);
    });

    ipcMain.handle('open-settings', () => this.createSettingsWindow());
    ipcMain.handle('close-settings', () => this.settingsWindow?.close());

    ipcMain.handle('folder:getPaths', () => ({
      APP_ROOT,
      KBD_DIR,
      JD_DIR,
      RESUME_DIR,
      SESSIONS_DIR,
      LOGS_DIR
    }));

    ipcMain.handle('folder:initialize', async () => {
      await initializeApplicationFolders();
      return { success: true, APP_ROOT, KBD_DIR, JD_DIR, RESUME_DIR, SESSIONS_DIR, LOGS_DIR };
    });

    ipcMain.handle('kbd:list', async () => listKbdFiles());
    ipcMain.handle('kbd:save', async (_, { fileName, data } = { fileName: '', data: '' }) => {
      const targetFile = await saveKbdFile(fileName, typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data || []));
      return { success: true, filePath: targetFile };
    });
    ipcMain.handle('kbd:delete', async (_, { fileName } = { fileName: '' }) => {
      return { success: await deleteKbdFile(fileName) };
    });

    ipcMain.handle('jd:list', async () => listJdFiles());
    ipcMain.handle('jd:save', async (_, { fileName, data } = { fileName: '', data: '' }) => {
      const targetFile = await saveJdFile(fileName, typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data || []));
      return { success: true, filePath: targetFile };
    });
    ipcMain.handle('jd:delete', async (_, { fileName } = { fileName: '' }) => {
      return { success: await deleteJdFile(fileName) };
    });

    ipcMain.handle('resume:list', async () => listResumeFiles());
    ipcMain.handle('resume:save', async (_, { fileName, data } = { fileName: '', data: '' }) => {
      const targetFile = await saveResumeFile(fileName, typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data || []));
      return { success: true, filePath: targetFile };
    });
    ipcMain.handle('resume:delete', async (_, { fileName } = { fileName: '' }) => {
      return { success: await deleteResumeFile(fileName) };
    });

    ipcMain.handle('session:list', async () => listSessions());
    ipcMain.handle('session:create', async (_, session) => {
      const sessionRecord = { ...(session || {}), id: String(session?.id || `session_${Date.now()}`) };
      const filePath = await saveSessionRecord(sessionRecord);
      return { success: true, filePath, session: sessionRecord };
    });
    ipcMain.handle('session:save', async (_, session) => {
      const sessionRecord = { ...(session || {}), id: String(session?.id || `session_${Date.now()}`) };
      const filePath = await saveSessionRecord(sessionRecord);
      return { success: true, filePath, session: sessionRecord };
    });
    ipcMain.handle('session:delete', async (_, { sessionId } = { sessionId: '' }) => {
      return { success: await deleteSessionRecord(sessionId) };
    });

    // Sessions
    ipcMain.handle('get-sessions', () => {
      const savedSessions = getSessions();
      if (this.currentSession) {
        // Merge current session into the list if it's not already there or if it's more recent
        const idx = savedSessions.findIndex(s => s.id === this.currentSession?.id);
        if (idx >= 0) {
          savedSessions[idx] = { ...this.currentSession };
        } else {
          savedSessions.unshift({ ...this.currentSession });
        }
      }
      return savedSessions;
    });
    ipcMain.handle('start-session', async (_, opts) => await this.startSession(opts));
    ipcMain.handle('end-session', () => this.endSession());

    // AI
    ipcMain.handle('generate-answer', async (_, { question, isCoding }) => {
      console.log('IPC: generate-answer triggered', { question, isCoding });
      await this.generateAnswer(question, isCoding, 'manual');
      return { success: true };
    });

    ipcMain.handle('analyze-screen', async () => {
      console.log('IPC: analyze-screen triggered');
      await this.analyzeScreen();
      return { success: true };
    });

    // Audio transcription - Groq Whisper transcription for MediaRecorder chunks
    ipcMain.handle('transcribe-audio-chunk', async (_, { audioBuffer, mimeType }) => {
      const buf = Buffer.from(audioBuffer);
      const result = await transcribeWithGroq(buf, { mimeType });
      if (result.success && result.text) {
        this.addTranscriptEntry(result.text, { provider: result.provider });
      }
      return result;
    });

    ipcMain.handle('start-live-deepgram', async () => {
      const settings = getSettings();
      const result = await this.deepgramLiveClient.start(settings.deepgramApiKey, payload => {
        this.addTranscriptEntry(payload.text, {
          isPartial: payload.isPartial,
          speechFinal: payload.speechFinal,
          provider: 'deepgram'
        });
      });
      return result;
    });

    ipcMain.on('send-live-stt-audio', (_, payload) => {
      if (!payload || !payload.audioBuffer) return;
      this.deepgramLiveClient.sendAudio(Buffer.from(payload.audioBuffer));
    });

    ipcMain.handle('get-deepgram-buffered-amount', () => {
      return this.deepgramLiveClient.getBufferedAmount();
    });

    ipcMain.handle('stop-live-deepgram', async () => {
      await this.deepgramLiveClient.stop();
      return { success: true };
    });

    // Window controls
    ipcMain.handle('set-opacity', (_, opacity) => {
      // Intentionally omitting native this.overlayWindow?.setOpacity to prevent black shadow artifacts.
      saveSettings({ windowOpacity: opacity });
    });

    ipcMain.handle('collapse-to-logo', () => this.toggleCollapse());
    ipcMain.handle('expand-from-logo', () => {
      if (this.isCollapsed) this.toggleCollapse();
    });

    ipcMain.handle('set-window-position', (_, position) => {
      saveSettings({ windowPosition: position });
      this.positionWindow(position);
    });

    ipcMain.handle('move-window', (_, { deltaX, deltaY }) => {
      if (!this.overlayWindow) return;
      const [x, y] = this.overlayWindow.getPosition();
      this.overlayWindow.setPosition(x + deltaX, y + deltaY);
    });

    ipcMain.handle('close-app', () => app.quit());

    ipcMain.handle('process-file', async (_, { filePath, source }: { filePath: string; source: 'resume' | 'jd' | 'kb' }) => {
      console.log('IPC: process-file', { filePath, source });
      try {
        if (!filePath) {
          throw new Error('No file path was provided by the file picker');
        }

        // Ensure folder exists
        const targetFolder = resolveContentFolder(source);
        await fs.ensureDir(targetFolder);

        const sourcePath = path.resolve(filePath);
        const fileName = path.basename(sourcePath);
        const targetPath = path.join(targetFolder, fileName);
        const sameSourceAndTarget = path.resolve(targetPath) === sourcePath;

        if (source === 'resume' || source === 'jd') {
          await embeddingService.clearSource(source);
          const existingFiles = await fs.readdir(targetFolder);
          for (const existingFile of existingFiles) {
            const existingPath = path.join(targetFolder, existingFile);
            if (sameSourceAndTarget && path.resolve(existingPath) === sourcePath) {
              continue;
            }
            await fs.remove(existingPath);
          }
        }
        
        // Copy file to local folder for persistence
        if (!sameSourceAndTarget) {
          await fs.copy(sourcePath, targetPath, { overwrite: true });
        }

        // Process and extract text
        const processed = await documentProcessor.processFile(targetPath, source, {
          allowImageOcr: true,
          visionModel: aiModelManager.getVisionModel()
        });
        
        // Add to embedding store
        await embeddingService.addDocument(processed.text, processed.source, processed.fileName);

        if (source === 'kb') {
          await kbdExactMatchService.warmCache(true);
          this.safeSendToOverlay('kbd-updated', { source: 'upload', fileName: processed.fileName, timestamp: Date.now() });
        }
        
        return { success: true, fileName: processed.fileName };
      } catch (err: any) {
        console.error('File processing error:', err);
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('update-jd-text', async (_, text: string) => {
      await embeddingService.clearSource('jd');
      await embeddingService.addDocument(text, 'jd', 'manual_jd.txt');
      return { success: true };
    });

    ipcMain.handle('get-rag-status', async () => {
      return retrievalService.getAllSources();
    });

    ipcMain.handle('get-kbd-questions', async () => {
      try {
        return await kbdExactMatchService.getAllEntries(true);
      } catch (error: any) {
        console.error('KBD: Failed to load questions', error);
        return { error: error?.message || 'Failed to load KBD questions' };
      }
    });

    ipcMain.handle('get-kbd-question-answer', async (_, id: string) => {
      try {
        const entry = await kbdExactMatchService.getEntryById(id, true);
        if (!entry) {
          return { success: false, error: 'KBD question not found' };
        }
        return { success: true, entry };
      } catch (error: any) {
        console.error('KBD: Failed to load question answer', error);
        return { success: false, error: error?.message || 'Failed to load KBD answer' };
      }
    });

    ipcMain.handle('get-kbd-related-questions', async (_, question: string) => {
      const query = String(question || '').trim();
      if (!query) {
        return { success: true, results: [] };
      }

      try {
        const results = await kbdRetrievalService.getRelatedQuestions(query, 8);
        return {
          success: true,
          results: results.map(item => ({
            id: item.id,
            question: item.question,
            answer: item.answer,
            fileName: item.fileName,
            score: Number(item.score || 0)
          }))
        };
      } catch (error: any) {
        console.error('KBD: Failed to fetch related questions', error);
        return { success: false, error: error?.message || 'Failed to fetch related KBD questions' };
      }
    });

    ipcMain.handle('search-kbd-questions', async (_, query: string, limit = 8) => {
      const searchTerm = String(query || '').trim();
      if (!searchTerm) {
        return { success: true, results: [] };
      }

      try {
        const results = await kbdRetrievalService.search(searchTerm, Number(limit) || 8);
        return {
          success: true,
          results: results.map(item => ({
            id: item.id,
            question: item.question,
            answer: item.answer,
            fileName: item.fileName,
            score: Number(item.score || 0)
          }))
        };
      } catch (error: any) {
        console.error('KBD: Failed to search KBD questions', error);
        return { success: false, error: error?.message || 'Failed to search KBD questions' };
      }
    });

    ipcMain.handle('record-kbd-search', async (_, payload) => {
      if (!this.currentSession) return { success: true };
      const term = String(payload?.term ?? payload?.query ?? '').trim();
      if (!term) return { success: true };
      this.recordSessionKbdActivity(this.currentSession, {
        type: 'manual-search',
        term,
        query: term,
        source: 'manual'
      });
      return { success: true };
    });

    ipcMain.handle('record-kbd-selection', async (_, payload) => {
      if (!this.currentSession) return { success: true };
      const question = String(payload?.question || payload?.matchedQuestion || '').trim();
      const recordId = String(payload?.id || payload?.kbdRecordId || '').trim();
      if (!question && !recordId) return { success: true };

      const sessionQuestion = (this.currentSession.questions ?? []).find(item => item.question === question || item.canonicalKbdQuestion === question || item.kbdRecordId === recordId);
      if (sessionQuestion) {
        sessionQuestion.kbdRecordId = recordId || sessionQuestion.kbdRecordId;
        sessionQuestion.selectedKbdQuestion = question || sessionQuestion.selectedKbdQuestion;
        sessionQuestion.canonicalKbdQuestion = question || sessionQuestion.canonicalKbdQuestion;
        if (payload?.answer) sessionQuestion.kbdAnswer = String(payload.answer);
      }

      this.recordSessionKbdActivity(this.currentSession, {
        type: 'selection',
        question: question || 'Selected KBD question',
        kbdRecordId: recordId || 'unknown',
        source: 'manual',
        score: typeof payload?.score === 'number' ? payload.score : undefined,
        query: String(payload?.query || question || '').trim() || undefined
      });
      return { success: true };
    });

    ipcMain.handle('set-click-through', (_, enabled: boolean) => {
      this.setClickThrough(enabled);
      return { success: true };
    });


    ipcMain.handle('resize-to-interview', () => {
      console.log('IPC: resize-to-interview');

      const width = this.currentLayout === 'portrait'
        ? OVERLAY_BAR_WIDTH_PORTRAIT
        : OVERLAY_BAR_WIDTH;

      const height = this.clampHeightToScreen(900);

      this.overlayWindow?.setResizable(true);
      this.overlayWindow?.setSize(width, height);
      this.positionWindow(getSettings().windowPosition);
    });

    ipcMain.handle('resize-to-dashboard', () => {
      const w = this.currentLayout === 'portrait' ? SETUP_W_PORTRAIT : SETUP_W_LANDSCAPE;
      const h = this.clampHeightToScreen(this.currentLayout === 'portrait' ? SETUP_H_PORTRAIT : SETUP_H_LANDSCAPE);
      this.overlayWindow?.setSize(w, h);
      this.overlayWindow?.setResizable(true);
    });

    ipcMain.handle('toggle-layout', () => {
      this.toggleLayout();
      return { layout: this.currentLayout };
    });

    ipcMain.handle('get-layout', () => {
      return { layout: this.currentLayout };
    });

    ipcMain.handle('get-app-version', () => app.getVersion());

    ipcMain.handle('open-external', (_, url) => shell.openExternal(url));

    ipcMain.handle('update-overlay-bounds', (_, { width, height }) => {
      if (!this.overlayWindow) return;
      const display = screen.getDisplayMatching(this.overlayWindow.getBounds());
      const workArea = display.workArea;
      const minW = this.currentLayout === 'portrait' ? 360 : 420;
      const maxW = Math.min(1200, workArea.width);
      const maxH = Math.floor(workArea.height * 0.94);
      const finalW = Math.max(minW, Math.min(width, maxW));
      const finalH = Math.max(86, Math.min(height, maxH));

      const current = this.overlayWindow.getBounds();

      this.overlayWindow.setSize(
        Math.max(current.width, finalW),
        Math.max(current.height, finalH)
      );

      const bounds = this.overlayWindow.getBounds();
      let newX = bounds.x;
      let newY = bounds.y;
      if (newX + finalW > workArea.x + workArea.width)  newX = workArea.x + workArea.width  - finalW;
      if (newY + finalH > workArea.y + workArea.height) newY = workArea.y + workArea.height - finalH;
      if (newX < workArea.x) newX = workArea.x;
      if (newY < workArea.y) newY = workArea.y;
      this.overlayWindow.setPosition(Math.floor(newX), Math.floor(newY));
    });

    ipcMain.handle('get-desktop-sources', async () => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        return { success: true, sources: sources.map(s => ({ id: s.id, name: s.name })) };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    // Mic permission check
    ipcMain.handle('request-mic-permission', async () => {
      // On Windows, permission is handled by the browser
      return { granted: true };
    });

    // Toggle auto-answer at runtime
    ipcMain.handle('toggle-auto-answer', (_, enabled) => {
      saveSettings({ autoAnswer: enabled });
      if (!enabled && this.autoAnswerTimeout) {
        clearTimeout(this.autoAnswerTimeout);
      }
    });

    ipcMain.handle('toggle-content-protection', (_, enabled: boolean) => {
      saveSettings({ contentProtection: enabled });
      if (this.overlayWindow) {
        const success = this.overlayWindow.setContentProtection(enabled);
        console.log(`[Main] Content Protection toggled to ${enabled}: ${success}`);
      }
      return { success: true };
    });

    // Clipboard controls
    ipcMain.handle('start-clipboard', () => {
      try { clipboardManager.start(); return { success: true }; } catch (e) { return { success: false, error: String(e) }; }
    });
    ipcMain.handle('stop-clipboard', () => {
      try { clipboardManager.stop(); return { success: true }; } catch (e) { return { success: false, error: String(e) }; }
    });
    ipcMain.handle('pause-clipboard', () => { clipboardManager.pause(); return { success: true }; });
    ipcMain.handle('resume-clipboard', () => { clipboardManager.resume(); return { success: true }; });
    ipcMain.handle('toggle-clipboard', () => { clipboardManager.toggle(); return { success: true }; });
    ipcMain.handle('get-clipboard-status', () => ({ status: clipboardManager.getStatus() }));
    ipcMain.handle('get-clipboard-history', () => ({ history: clipboardManager.getHistory() }));
    ipcMain.handle('clear-clipboard-history', () => { clipboardManager.clearHistory(); return { success: true }; });
  }

  private async handleRendererGone(details: any): Promise<void> {
    console.error('[Main] Handling renderer gone:', details?.reason, 'exitCode=', details?.exitCode, 'wasKilled=', details?.wasKilled);

    // Stop session timer
    try { if (this.sessionTimer) { clearInterval(this.sessionTimer); this.sessionTimer = null; } } catch (e) { }

    // Stop auto-answer timer
    try { if (this.autoAnswerTimeout) { clearTimeout(this.autoAnswerTimeout); this.autoAnswerTimeout = null; } } catch (e) { }

    // Clear debounce timers
    try { if (this.kbWatcherDebounce) { clearTimeout(this.kbWatcherDebounce); this.kbWatcherDebounce = null; } } catch (e) { }
    try { if (this.sqlDatasetWatcherDebounce) { clearTimeout(this.sqlDatasetWatcherDebounce); this.sqlDatasetWatcherDebounce = null; } } catch (e) { }

    // Stop Deepgram live client
    try { await this.deepgramLiveClient.stop(); } catch (e) { console.warn('[Main] deepgram stop failed', e); }

    // Ensure audio capture manager resets
    try { audioCaptureManager.stopCapture(); } catch (e) { /* ignore */ }

    // Reset interview-related flags
    this.isInterviewMode = false;
    this.pendingAutoAnswerAfterStream = false;
    this.isAIStreaming = false;

    console.error('[Main] Renderer gone cleanup completed');
  }
}

// ─── App Bootstrap ────────────────────────────────────────────────────────────

const appInstance = new GroqInterviewApp();

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

app.on('second-instance', () => {
  appInstance.focusMainWindow();
});

app.whenReady().then(async () => {
  try {
    await initializeApplicationFolders();
    app.setPath('userData', APP_ROOT);
    app.setPath('sessionData', SESSIONS_DIR);
    app.setPath('logs', LOGS_DIR);
  } catch (error: any) {
    console.error('[Startup] Failed to initialize SpeakEasy AI storage directories:', error);
    dialog.showErrorBox('SpeakEasy AI startup failed', STARTUP_ERROR_MESSAGE);
    app.exit(1);
    return;
  }

  app.setAppUserModelId(APP_ID);
  appInstance.createOverlayWindow();
  appInstance.registerIPC();
  appInstance.registerShortcuts();

  // Configure display-media handler for system audio capture (Windows loopback)
  try {
    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
      console.log('[SYSTEM-AUDIO] Display media request handler invoked');
      console.log('[SYSTEM-AUDIO] videoRequested:', Boolean(request.videoRequested));
      console.log('[SYSTEM-AUDIO] audioRequested:', Boolean(request.audioRequested));

      // Prepare response object based on what the renderer requested.
      try {
        if (!request.videoRequested && !request.audioRequested) {
          // Nothing requested — deny gracefully
          callback({});
          return;
        }

        // Acquire desktop sources once
        let sources: Electron.DesktopCapturerSource[] = [];
        try {
          sources = await desktopCapturer.getSources({ types: ['screen'] });
        } catch (err) {
          console.warn('[SYSTEM-AUDIO] desktopCapturer.getSources failed:', err);
        }

        const response: any = {};

        if (request.videoRequested) {
          // Try to pick a matching source for the overlay window / primary display
          let selectedSource: Electron.DesktopCapturerSource | undefined = undefined;
          try {
            const targetDisplay = screen.getPrimaryDisplay();
            const targetId = String(targetDisplay.id);
            selectedSource = sources.find(s => s.display_id === targetId) || sources[0];
          } catch (e) {
            // fall back to first source if any
            selectedSource = sources && sources.length ? sources[0] : undefined;
          }

          if (!selectedSource) {
            console.warn('[SYSTEM-AUDIO] No screen source available to satisfy video request');
            // If video was explicitly requested but no video source exists, deny the request (empty response).
            callback({});
            return;
          }

          console.log('[SYSTEM-AUDIO] Selected source:', selectedSource.name || selectedSource.id);
          console.log('[SYSTEM-AUDIO] Granting video source');
          response.video = selectedSource as any;
        }

        if (request.audioRequested) {
          console.log('[SYSTEM-AUDIO] Granting Windows audio loopback');
          response.audio = 'loopback';
        }

        // Finally, deliver the constructed response
        callback(response);
      } catch (err) {
        console.warn('[SYSTEM-AUDIO] Display media handler error:', err);
        try { callback({}); } catch (e) { /* ignore */ }
      }
    });

    console.log('[SYSTEM-AUDIO] Display media request handler configured');
  } catch (e) {
    console.warn('[SYSTEM-AUDIO] Failed to configure display media handler:', e);
  }

  // Wire clipboard event hook so clipboard manager can forward events to renderer
  (global as any).__clipboardEventHook = (channel: string, payload: any) => {
    appInstance.forwardClipboardEvent(channel, payload);
  };
  // Start clipboard manager by default if enabled in settings
  try { clipboardManager.start(); } catch (e) { console.warn('Failed to start clipboard manager', e); }
});

app.on('window-all-closed', () => {
  appInstance.unregisterShortcuts();
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  appInstance.unregisterShortcuts();
  try { clipboardManager.stop(); } catch (e) { /* ignore */ }
});
