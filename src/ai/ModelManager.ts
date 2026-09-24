import { EventEmitter } from 'events';

import { getSettings, saveModelCatalog, saveSettings } from '../store';
import { GroqProvider } from './GroqProvider';
import { ModelRegistry, modelRegistry } from './ModelRegistry';
import {
  AIModelCapability,
  AIRequestMetric,
  GroqDiscoveredModel,
  GroqModelCatalog,
  TokenUsage,
  emptyModelCatalog
} from './ModelSettings';

export { TokenUsage } from './ModelSettings';

export interface ModelRunResult<T> {
  value: T;
  tokens?: TokenUsage;
}

export interface ModelRunContext {
  capability: AIModelCapability;
  task: string;
  selectedModel?: string;
  onFallback?: (failedModel: string, nextModel: string, error: unknown) => void;
}

type ModelOperation<T> = (model: string, fallbackUsed: boolean) => Promise<ModelRunResult<T>>;

export class ModelManager extends EventEmitter {
  private readonly metrics: AIRequestMetric[] = [];
  private readonly maxMetrics = 100;
  private provider: GroqProvider | null = null;

  constructor(private readonly registry: ModelRegistry = modelRegistry) {
    super();
  }

  setGroqProvider(provider: GroqProvider): void {
    this.provider = provider;
  }

  async refreshModels(): Promise<GroqModelCatalog> {
    if (!this.provider) {
      return this.registry.getCatalog();
    }

    try {
      const catalog = await this.provider.refreshModels();
      saveModelCatalog(catalog);
      this.normalizePersistedSettings();
      return catalog;
    } catch (error) {
      const message = this.getErrorMessage(error);
      const currentCatalog = this.registry.getCatalog();
      const catalog = currentCatalog.source === 'empty'
        ? emptyModelCatalog('empty', message)
        : { ...currentCatalog, source: 'cache' as const, error: message };
      this.registry.setCatalog(catalog);
      console.error('[AI Models]', { apiError: message });
      return this.registry.getCatalog();
    }
  }

  loadCachedCatalog(catalog?: GroqModelCatalog): void {
    if (catalog) {
      this.registry.setCatalog({ ...catalog, source: 'cache' });
    }
  }

  getChatModel(): string {
    return this.resolveSelectedModel('chat', getSettings().chatModel);
  }

  getVisionModel(): string {
    return this.resolveSelectedModel('vision', getSettings().visionModel);
  }

  getSpeechModel(): string {
    return this.resolveSelectedModel('speech', getSettings().speechModel);
  }

  getAgentModel(): string {
    return this.resolveSelectedModel('agent', getSettings().agentModel);
  }

  setChatModel(model: string): string {
    const resolved = this.resolveSelectedModel('chat', model);
    saveSettings({ chatModel: resolved });
    return resolved;
  }

  setVisionModel(model: string): string {
    const resolved = this.resolveSelectedModel('vision', model);
    saveSettings({ visionModel: resolved });
    return resolved;
  }

  setSpeechModel(model: string): string {
    const resolved = this.resolveSelectedModel('speech', model);
    saveSettings({ speechModel: resolved });
    return resolved;
  }

  setAgentModel(model: string): string {
    const resolved = this.resolveSelectedModel('agent', model);
    saveSettings({ agentModel: resolved });
    return resolved;
  }

  getModelCatalog(): GroqModelCatalog {
    return this.registry.getCatalog();
  }

  getModels(capability: AIModelCapability): GroqDiscoveredModel[] {
    return this.registry.getModels(capability);
  }

  normalizeModelId(capability: AIModelCapability, model?: string): string {
    return this.resolveSelectedModel(capability, model);
  }

  getMetrics(): AIRequestMetric[] {
    return [...this.metrics];
  }

  async runWithFallback<T>(
    context: ModelRunContext,
    operation: ModelOperation<T>
  ): Promise<T> {
    const orderedModels = this.registry.getExecutionOrder(context.capability, context.selectedModel);
    if (!orderedModels.length) {
      throw new Error(`No Groq ${context.capability} models are available for this API key.`);
    }

    let lastError: unknown;

    for (let index = 0; index < orderedModels.length; index++) {
      const model = orderedModels[index];
      const fallbackUsed = index > 0;
      const startedAt = Date.now();
      const requestTime = new Date(startedAt).toISOString();

      console.log('[AI]', {
        selectedModel: model,
        currentTask: context.task,
        requestTime,
        fallbackUsed
      });

      try {
        const result = await operation(model, fallbackUsed);
        const latency = Date.now() - startedAt;
        this.recordMetric({
          id: `${startedAt}-${this.metrics.length}`,
          selectedModel: model,
          task: context.task,
          capability: context.capability,
          latencyMs: latency,
          inputTokens: result.tokens?.promptTokens,
          outputTokens: result.tokens?.completionTokens,
          totalTokens: result.tokens?.totalTokens,
          estimatedTokens: result.tokens?.estimated,
          fallbackUsed,
          requestTime
        });
        return result.value;
      } catch (error) {
        lastError = error;
        const latency = Date.now() - startedAt;
        const apiError = this.getErrorMessage(error);
        this.recordMetric({
          id: `${startedAt}-${this.metrics.length}`,
          selectedModel: model,
          task: context.task,
          capability: context.capability,
          latencyMs: latency,
          apiError,
          fallbackUsed,
          requestTime
        });

        const nextModel = orderedModels[index + 1];
        if (nextModel) {
          context.onFallback?.(model, nextModel, error);
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError || 'AI request failed'));
  }

  private resolveSelectedModel(capability: AIModelCapability, model?: string): string {
    return this.registry.resolveModel(capability, model);
  }

  private normalizePersistedSettings(): void {
    const settings = getSettings();
    saveSettings({
      chatModel: this.resolveSelectedModel('chat', settings.chatModel),
      visionModel: this.resolveSelectedModel('vision', settings.visionModel),
      speechModel: this.resolveSelectedModel('speech', settings.speechModel),
      agentModel: this.resolveSelectedModel('agent', settings.agentModel)
    });
  }

  private recordMetric(metric: AIRequestMetric): void {
    this.metrics.unshift(metric);
    this.metrics.splice(this.maxMetrics);

    const logPayload = {
      selectedModel: metric.selectedModel,
      task: metric.task,
      latencyMs: metric.latencyMs,
      inputTokens: metric.inputTokens ?? 'unavailable',
      outputTokens: metric.outputTokens ?? 'unavailable',
      totalTokens: metric.totalTokens ?? 'unavailable',
      fallbackUsed: metric.fallbackUsed,
      requestTime: metric.requestTime,
      apiError: metric.apiError
    };

    if (metric.apiError) {
      console.error('[AI]', logPayload);
    } else {
      console.log('[AI]', logPayload);
    }

    this.emit('metric', metric);
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error || 'Unknown API error');
  }
}

export const aiModelManager = new ModelManager();
