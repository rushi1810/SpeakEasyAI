export type AIModelCapability = 'chat' | 'vision' | 'speech' | 'agent';

export interface GroqDiscoveredModel {
  id: string;
  label: string;
  capability: AIModelCapability;
  ownedBy?: string;
  created?: number;
  description?: string;
}

export interface GroqModelCatalog {
  chat: GroqDiscoveredModel[];
  vision: GroqDiscoveredModel[];
  speech: GroqDiscoveredModel[];
  agent: GroqDiscoveredModel[];
  refreshedAt: number | null;
  source: 'groq' | 'cache' | 'empty';
  error?: string;
}

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  estimated?: boolean;
}

export interface AIRequestMetric {
  id: string;
  selectedModel: string;
  task: string;
  capability: AIModelCapability;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedTokens?: boolean;
  apiError?: string;
  fallbackUsed: boolean;
  requestTime: string;
}

export const FALLBACK_MODEL_IDS: Record<AIModelCapability, string[]> = {
  chat: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'],
  vision: ['qwen/qwen3.6-27b'],
  speech: ['whisper-large-v3', 'whisper-large-v3-turbo'],
  agent: ['groq/compound', 'groq/compound-mini']
};

export function emptyModelCatalog(source: GroqModelCatalog['source'] = 'empty', error?: string): GroqModelCatalog {
  return {
    chat: [],
    vision: [],
    speech: [],
    agent: [],
    refreshedAt: null,
    source,
    error
  };
}
