import type { Model } from 'groq-sdk/resources/models';

import {
  AIModelCapability,
  FALLBACK_MODEL_IDS,
  GroqDiscoveredModel,
  GroqModelCatalog,
  emptyModelCatalog
} from './ModelSettings';

export class ModelRegistry {
  private catalog: GroqModelCatalog = emptyModelCatalog();

  getCatalog(): GroqModelCatalog {
    return {
      chat: [...this.catalog.chat],
      vision: [...this.catalog.vision],
      speech: [...this.catalog.speech],
      agent: [...this.catalog.agent],
      refreshedAt: this.catalog.refreshedAt,
      source: this.catalog.source,
      error: this.catalog.error
    };
  }

  setModels(models: Model[], source: GroqModelCatalog['source'] = 'groq'): GroqModelCatalog {
    const nextCatalog = emptyModelCatalog(source);

    for (const model of models) {
      const entry = this.toDiscoveredModel(model);
      nextCatalog[entry.capability].push(entry);
    }

    for (const capability of this.capabilities()) {
      nextCatalog[capability] = this.sortModels(nextCatalog[capability], capability);
    }

    nextCatalog.refreshedAt = Date.now();
    this.catalog = nextCatalog;
    return this.getCatalog();
  }

  setCatalog(catalog: GroqModelCatalog): void {
    this.catalog = {
      chat: this.sortModels(catalog.chat || [], 'chat'),
      vision: this.sortModels(catalog.vision || [], 'vision'),
      speech: this.sortModels(catalog.speech || [], 'speech'),
      agent: this.sortModels(catalog.agent || [], 'agent'),
      refreshedAt: catalog.refreshedAt || null,
      source: catalog.source || 'cache',
      error: catalog.error
    };
  }

  getModels(capability: AIModelCapability): GroqDiscoveredModel[] {
    return [...this.catalog[capability]];
  }

  hasModel(capability: AIModelCapability, modelId?: string): boolean {
    if (!modelId) return false;
    return this.catalog[capability].some(model => model.id === modelId);
  }

  resolveModel(capability: AIModelCapability, selectedModel?: string): string {
    if (!this.catalog[capability].length) {
      return selectedModel || '';
    }

    if (this.hasModel(capability, selectedModel)) {
      return selectedModel as string;
    }

    const fallback = this.getFallbackModels(capability)[0];
    if (fallback) return fallback;

    return this.catalog[capability][0]?.id || '';
  }

  getFallbackModels(capability: AIModelCapability): string[] {
    const availableIds = new Set(this.catalog[capability].map(model => model.id));
    return FALLBACK_MODEL_IDS[capability].filter(id => availableIds.has(id));
  }

  getExecutionOrder(capability: AIModelCapability, selectedModel?: string): string[] {
    const selected = this.resolveModel(capability, selectedModel);
    return Array.from(new Set([
      selected,
      ...this.getFallbackModels(capability),
      ...this.catalog[capability].map(model => model.id)
    ].filter(Boolean)));
  }

  private toDiscoveredModel(model: Model): GroqDiscoveredModel {
    const id = model.id;
    const capability = this.categorize(id);
    return {
      id,
      label: id,
      capability,
      ownedBy: model.owned_by,
      created: model.created,
      description: this.describeModel(id, capability)
    };
  }

  private categorize(id: string): AIModelCapability {
    const normalized = id.toLowerCase();

    if (normalized.includes('whisper')) {
      return 'speech';
    }

    if (normalized.includes('compound')) {
      return 'agent';
    }

    if (
      normalized.includes('vision') ||
      normalized.includes('vl') ||
      normalized.includes('multimodal') ||
      normalized.includes('qwen3.6')
    ) {
      return 'vision';
    }

    return 'chat';
  }

  private describeModel(id: string, capability: AIModelCapability): string {
    if (capability === 'speech') return 'Speech-to-text';
    if (capability === 'vision') return 'Vision and OCR';
    if (capability === 'agent') return 'Agentic workflow';
    if (/instant/i.test(id)) return 'Low-latency chat';
    if (/120b|70b/i.test(id)) return 'High-capacity chat';
    return 'Chat and reasoning';
  }

  private sortModels(models: GroqDiscoveredModel[], capability: AIModelCapability): GroqDiscoveredModel[] {
    const fallbackRank = new Map(FALLBACK_MODEL_IDS[capability].map((id, index) => [id, index]));
    return [...models].sort((left, right) => {
      const leftRank = fallbackRank.has(left.id) ? fallbackRank.get(left.id)! : Number.MAX_SAFE_INTEGER;
      const rightRank = fallbackRank.has(right.id) ? fallbackRank.get(right.id)! : Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.id.localeCompare(right.id);
    });
  }

  private capabilities(): AIModelCapability[] {
    return ['chat', 'vision', 'speech', 'agent'];
  }
}

export const modelRegistry = new ModelRegistry();
