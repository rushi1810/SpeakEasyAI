import { app } from 'electron';
import Store from 'electron-store';
import { APP_ROOT, LOGS_DIR, SESSIONS_DIR, ensureAppRootExistsSync } from './main/paths';
import { saveSessionRecord } from './main/folderManager';
import type { GroqModelCatalog } from './ai/ModelSettings';

app.setPath('userData', APP_ROOT);
app.setPath('sessionData', SESSIONS_DIR);
app.setPath('logs', LOGS_DIR);

// electron-store is constructed while the main bundle is loading, before
// app.whenReady() initializes the rest of the application. Ensure its
// explicitly configured writable directory exists first.
ensureAppRootExistsSync();

export interface AppSettings {
  groqApiKey: string;
  chatModel: string;
  visionModel: string;
  speechModel: string;
  agentModel: string;
  autoAnswer: boolean;
  autoAnswerDelay: number; // seconds of silence before auto-triggering
  windowOpacity: number;
  windowPosition: 'top-left' | 'top-center' | 'top-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';
  customInstructions: string;
  company: string;
  position: string;
  resume: string;
  deepgramApiKey: string;
  contentProtection: boolean;
  windowLayout: 'landscape' | 'portrait';
  clipboardSettings?: {
    enabled: boolean;
    autoAnswer: boolean;
    historyEnabled: boolean;
    autoCopyAnswer: boolean;
    cooldownSeconds: number;
    maxSize: number;
    detectionSensitivity: string;
  };
  modelCatalog?: GroqModelCatalog;
}

export interface SessionQuestionRecord {
  id: string;
  question: string;
  rawTranscript?: string;
  normalizedTranscript?: string;
  correctedQuestion?: string;
  canonicalKbdQuestion?: string;
  kbdRecordId?: string;
  relatedKbdQuestions?: Array<{ id: string; question: string; score?: number }>;
  selectedKbdQuestion?: string;
  kbdAnswer?: string;
  aiAnswer?: string;
  timestamp: number;
}

export interface SessionKbdActivityRecord {
  id: string;
  type: 'manual-search' | 'auto-suggest' | 'selection';
  term?: string;
  query?: string;
  question?: string;
  kbdRecordId?: string;
  score?: number;
  source?: 'auto' | 'manual';
  timestamp: number;
}

export interface SessionRecord {
  id: string;
  company: string;
  position: string;
  startTime: number;
  endTime?: number;
  transcript: TranscriptEntry[];
  aiConversations: AIConversationEntry[];
  jdText?: string;
  questions?: SessionQuestionRecord[];
  kbdActivity?: SessionKbdActivityRecord[];
}

export interface TranscriptEntry {
  id: string;
  text: string;
  timestamp: number;
  source: 'mic' | 'system';
}

export interface AIConversationEntry {
  id: string;
  trigger: 'manual' | 'screen' | 'auto';
  question: string;
  answer: string;
  timestamp: number;
}

const schema = {
  groqApiKey: { type: 'string', default: '' },
  chatModel: { type: 'string', default: '' },
  visionModel: { type: 'string', default: '' },
  speechModel: { type: 'string', default: '' },
  agentModel: { type: 'string', default: '' },
  autoAnswer: { type: 'boolean', default: true },
  autoAnswerDelay: { type: 'number', default: 3 },
  windowOpacity: { type: 'number', default: 95 },
  windowPosition: { type: 'string', default: 'top-center' },
  customInstructions: { type: 'string', default: '' },
  company: { type: 'string', default: '' },
  position: { type: 'string', default: '' },
  resume: { type: 'string', default: '' },
  deepgramApiKey: { type: 'string', default: '' },
  contentProtection: { type: 'boolean', default: false },
  windowLayout: { type: 'string', default: 'landscape' },
  clipboardSettings: { type: 'object', default: {
    enabled: true,
    autoAnswer: true,
    historyEnabled: true,
    autoCopyAnswer: false,
    cooldownSeconds: 2,
    maxSize: 10000,
    detectionSensitivity: 'medium'
  } },
  modelCatalog: { type: ['object', 'null'], default: null },
  sessions: { type: 'array', default: [] }
} as any;

export const store = new Store({
  name: 'config',
  cwd: APP_ROOT,
  schema
} as any);

for (const key of Object.keys(store.store as Record<string, unknown>)) {
  const normalizedKey = key.toLowerCase();
  const isSupportedApiKey = key === 'groqApiKey' || key === 'deepgramApiKey';
  const isLegacyProviderSetting = normalizedKey.includes('provider') || normalizedKey.includes('priority');
  const isLegacyTranscriptionSetting = normalizedKey.includes('transcription');
  const isUnknownApiKey = normalizedKey.endsWith('apikey') && !isSupportedApiKey;

  if (isLegacyProviderSetting || isLegacyTranscriptionSetting || isUnknownApiKey) {
    store.delete(key);
  }
}

export function getSettings(): AppSettings {
  return {
    groqApiKey: store.get('groqApiKey') as string,
    chatModel: (store.get('chatModel') as string) || '',
    visionModel: (store.get('visionModel') as string) || '',
    speechModel: (store.get('speechModel') as string) || '',
    agentModel: (store.get('agentModel') as string) || '',
    autoAnswer: store.get('autoAnswer') as boolean,
    autoAnswerDelay: store.get('autoAnswerDelay') as number,
    windowOpacity: store.get('windowOpacity') as number,
    windowPosition: store.get('windowPosition') as AppSettings['windowPosition'],
    customInstructions: store.get('customInstructions') as string,
    company: store.get('company') as string,
    position: store.get('position') as string,
    resume: store.get('resume') as string,
    deepgramApiKey: store.get('deepgramApiKey') as string,
    contentProtection: store.get('contentProtection') as boolean,
    windowLayout: (store.get('windowLayout') as AppSettings['windowLayout']) || 'landscape'
    ,
    clipboardSettings: (store.get('clipboardSettings') as any) || undefined,
    modelCatalog: (store.get('modelCatalog') as GroqModelCatalog | undefined) || undefined
  };
}

export function saveSettings(settings: Partial<AppSettings>): void {
  Object.entries(settings).forEach(([key, value]) => {
    store.set(key, value);
  });
}

export function getCachedModelCatalog(): GroqModelCatalog | undefined {
  return store.get('modelCatalog') as GroqModelCatalog | undefined;
}

export function saveModelCatalog(catalog: GroqModelCatalog): void {
  store.set('modelCatalog', catalog);
}

export function getSessions(): SessionRecord[] {
  return store.get('sessions') as SessionRecord[];
}

export function saveSession(session: SessionRecord): void {
  const sessions = getSessions();
  const idx = sessions.findIndex(s => s.id === session.id);
  if (idx >= 0) sessions[idx] = session;
  else sessions.unshift(session);
  // Keep last 50 sessions
  const trimmedSessions = sessions.slice(0, 50);
  store.set('sessions', trimmedSessions);

  try {
    void saveSessionRecord(session).catch((error) => {
      console.warn('[Store] Failed to persist session file to C:\\SpeakEasy AI\\Sessions\\', error);
    });
  } catch (error) {
    console.warn('[Store] Failed to persist session file to C:\\SpeakEasy AI\\Sessions\\', error);
  }
}
