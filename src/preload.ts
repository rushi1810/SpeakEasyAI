"use strict";
import { contextBridge, ipcRenderer } from 'electron';

const speakEasyAPI = {
  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s: any) => ipcRenderer.invoke('save-settings', s),
  getAIModels: () => ipcRenderer.invoke('get-ai-models'),
  refreshAIModels: () => ipcRenderer.invoke('refresh-ai-models'),
  getAIMetrics: () => ipcRenderer.invoke('get-ai-metrics'),
  validateApiKey: (key: string) => ipcRenderer.invoke('validate-api-key', key),
  openSettings: () => ipcRenderer.invoke('open-settings'),
  closeSettings: () => ipcRenderer.invoke('close-settings'),

  // Sessions
  getSessions: () => ipcRenderer.invoke('get-sessions'),
  startSession: (opts: any) => ipcRenderer.invoke('start-session', opts),
  endSession: () => ipcRenderer.invoke('end-session'),
  saveSessionText: (session: any) => ipcRenderer.invoke('save-session-text', session),

  // AI
  generateAnswer: (opts: any) => ipcRenderer.invoke('generate-answer', opts),
  analyzeScreen: () => ipcRenderer.invoke('analyze-screen'),
  transcribeAudioChunk: (data: any) => ipcRenderer.invoke('transcribe-audio-chunk', data),
  startLiveDeepgram: () => ipcRenderer.invoke('start-live-deepgram'),
  sendLiveSttAudio: (data: any) => ipcRenderer.send('send-live-stt-audio', data),
  getDeepgramBufferedAmount: () => ipcRenderer.invoke('get-deepgram-buffered-amount'),
  stopLiveDeepgram: () => ipcRenderer.invoke('stop-live-deepgram'),
  toggleAutoAnswer: (enabled: boolean) => ipcRenderer.invoke('toggle-auto-answer', enabled),
  processFile: (data: { filePath: string, source: string }) => ipcRenderer.invoke('process-file', data),
  updateJDText: (text: string) => ipcRenderer.invoke('update-jd-text', text),
  getRAGStatus: () => ipcRenderer.invoke('get-rag-status'),
  getKBDQuestions: () => ipcRenderer.invoke('get-kbd-questions'),
  getKBDQuestionAnswer: (id: string) => ipcRenderer.invoke('get-kbd-question-answer', id),
  getKBDRelatedQuestions: (question: string) => ipcRenderer.invoke('get-kbd-related-questions', question),
  searchKBDQuestions: (query: string, limit?: number) => ipcRenderer.invoke('search-kbd-questions', query, limit),
  recordKBDSearch: (term: string, results: number) => ipcRenderer.invoke('record-kbd-search', { term, results }),
  recordKBDSelection: (entry: any) => ipcRenderer.invoke('record-kbd-selection', entry),

  // Window
  setOpacity: (v: number) => ipcRenderer.invoke('set-opacity', v),
  collapseToLogo: () => ipcRenderer.invoke('collapse-to-logo'),
  expandFromLogo: () => ipcRenderer.invoke('expand-from-logo'),
  setWindowPosition: (pos: string) => ipcRenderer.invoke('set-window-position', pos),
  moveWindow: (d: any) => ipcRenderer.invoke('move-window', d),
  closeApp: () => ipcRenderer.invoke('close-app'),
  setClickThrough: (v: boolean) => ipcRenderer.invoke('set-click-through', v),
  resizeToInterview: (showPanel: boolean) => ipcRenderer.invoke('resize-to-interview', showPanel),
  resizeToDashboard: () => ipcRenderer.invoke('resize-to-dashboard'),
  toggleLayout: () => ipcRenderer.invoke('toggle-layout'),
  getLayout: () => ipcRenderer.invoke('get-layout'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  updateOverlayBounds: (bounds: any) => ipcRenderer.invoke('update-overlay-bounds', bounds),
  getDesktopSources: () => ipcRenderer.invoke('get-desktop-sources'),
  requestMicPermission: () => ipcRenderer.invoke('request-mic-permission'),
  setProtection: (enable: boolean) => ipcRenderer.invoke('toggle-content-protection', enable),

  // Clipboard control
  startClipboard: () => ipcRenderer.invoke('start-clipboard'),
  stopClipboard: () => ipcRenderer.invoke('stop-clipboard'),
  pauseClipboard: () => ipcRenderer.invoke('pause-clipboard'),
  resumeClipboard: () => ipcRenderer.invoke('resume-clipboard'),
  toggleClipboard: () => ipcRenderer.invoke('toggle-clipboard'),
  getClipboardStatus: () => ipcRenderer.invoke('get-clipboard-status'),
  getClipboardHistory: () => ipcRenderer.invoke('get-clipboard-history'),
  clearClipboardHistory: () => ipcRenderer.invoke('clear-clipboard-history'),

  // Events: main → renderer
  onModeChanged: (cb: (e: any) => void) => {
    ipcRenderer.on('mode-changed', (_, data) => cb(data));
  },
  onTranscriptUpdate: (cb: (e: any) => void) => {
    ipcRenderer.on('transcript-update', (_, data) => cb(data));
  },
  onSessionTimerUpdate: (cb: (s: number) => void) => {
    ipcRenderer.on('session-timer-update', (_, s) => cb(s));
  },
  onCollapseStateChanged: (cb: (e: any) => void) => {
    ipcRenderer.on('collapse-state-changed', (_, data) => cb(data));
  },
  onClickThroughChanged: (cb: (v: boolean) => void) => {
    ipcRenderer.on('click-through-changed', (_, v) => cb(v));
  },
  onAIPanelClosed: (cb: () => void) => {
    ipcRenderer.on('ai-panel-closed', () => cb());
  },
  onAIPanelOpened: (cb: () => void) => {
    ipcRenderer.on('ai-panel-opened', () => cb());
  },
  onAIPanelMessage: (cb: (msg: string) => void) => {
    ipcRenderer.on('ai-panel-message', (_, msg) => cb(msg));
  },
  onAIModelsUpdated: (cb: (catalog: any) => void) => {
    ipcRenderer.on('ai-models-updated', (_, catalog) => cb(catalog));
  },
  onAIMetric: (cb: (metric: any) => void) => {
    ipcRenderer.on('ai-metric', (_, metric) => cb(metric));
  },

  // Mic capture commands (main → renderer)
  onStartMicCapture: (cb: () => void) => {
    ipcRenderer.on('start-mic-capture', () => cb());
  },
  onStopMicCapture: (cb: () => void) => {
    ipcRenderer.on('stop-mic-capture', () => cb());
  },
  onStartSystemAudioCapture: (cb: () => void) => {
    ipcRenderer.on('start-system-audio-capture', () => cb());
  },
  onStopSystemAudioCapture: (cb: () => void) => {
    ipcRenderer.on('stop-system-audio-capture', () => cb());
  },
  onToast: (cb: (data: any) => void) => {
    ipcRenderer.on('toast', (_, data) => cb(data));
  },
  onLayoutChanged: (cb: (data: any) => void) => {
    ipcRenderer.on('layout-changed', (_, data) => cb(data));
  },
  onKBDUpdated: (cb: (data: any) => void) => {
    ipcRenderer.on('kbd-updated', (_, data) => cb(data));
  },
  onKBDRelatedQuestions: (cb: (data: any) => void) => {
    ipcRenderer.on('kbd-related-questions', (_, data) => cb(data));
  },
  onClipboardDetected: (cb: (data: any) => void) => {
    ipcRenderer.on('clipboard-detected', (_, data) => cb(data));
  },
  onUserResizeStart: (cb: () => void) => {
    ipcRenderer.on('user-resize-start', () => cb());
  },
  onUserResizeEnd: (cb: () => void) => {
    ipcRenderer.on('user-resize-end', () => cb());
  },

  // Platform
  getPlatform: () => process.platform,

  // Storage and folder management
  getPaths: () => ipcRenderer.invoke('folder:getPaths'),
  initialize: () => ipcRenderer.invoke('folder:initialize'),
  listKBD: () => ipcRenderer.invoke('kbd:list'),
  saveKBD: (fileName: string, data: string | Uint8Array) => ipcRenderer.invoke('kbd:save', { fileName, data }),
  deleteKBD: (fileName: string) => ipcRenderer.invoke('kbd:delete', { fileName }),
  listJD: () => ipcRenderer.invoke('jd:list'),
  saveJD: (fileName: string, data: string | Uint8Array) => ipcRenderer.invoke('jd:save', { fileName, data }),
  deleteJD: (fileName: string) => ipcRenderer.invoke('jd:delete', { fileName }),
  listResume: () => ipcRenderer.invoke('resume:list'),
  saveResume: (fileName: string, data: string | Uint8Array) => ipcRenderer.invoke('resume:save', { fileName, data }),
  deleteResume: (fileName: string) => ipcRenderer.invoke('resume:delete', { fileName }),
  listSessions: () => ipcRenderer.invoke('session:list'),
  createSession: (session: any) => ipcRenderer.invoke('session:create', session),
  saveSession: (session: any) => ipcRenderer.invoke('session:save', session),
  deleteSession: (sessionId: string) => ipcRenderer.invoke('session:delete', { sessionId })
};

contextBridge.exposeInMainWorld('electronAPI', speakEasyAPI);
contextBridge.exposeInMainWorld('speakEasy', speakEasyAPI);
