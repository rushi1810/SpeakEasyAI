import type Groq from 'groq-sdk';
import type { ChatCompletionMessageParam } from 'groq-sdk/resources/chat/completions';

import { ModelManager, TokenUsage } from './ModelManager';

export interface VisionCompletionOptions {
  task: string;
  selectedModel?: string;
  messages: ChatCompletionMessageParam[];
  maxTokens?: number;
  temperature?: number;
  responseFormat?: { type: 'text' | 'json_object' };
  requestOptions?: Record<string, unknown>;
}

export interface VisionStreamOptions extends VisionCompletionOptions {
  onChunk: (chunk: string) => void;
  onReset?: (model: string) => void;
}

export class VisionProvider {
  constructor(
    private readonly getClient: () => Groq,
    private readonly modelManager: ModelManager
  ) {}

  async complete(options: VisionCompletionOptions): Promise<string> {
    return this.modelManager.runWithFallback<string>({
      capability: 'vision',
      task: options.task,
      selectedModel: options.selectedModel
    }, async (model) => {
      const response: any = await this.getClient().chat.completions.create({
        model,
        messages: options.messages,
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        response_format: options.responseFormat
      } as any, options.requestOptions as any);

      const content = this.flattenContent(response.choices?.[0]?.message?.content);
      return {
        value: content,
        tokens: this.extractUsage(response) || this.estimateUsage(options.messages, content)
      };
    });
  }

  async stream(options: VisionStreamOptions): Promise<string> {
    let lastAttemptHadOutput = false;

    return this.modelManager.runWithFallback<string>({
      capability: 'vision',
      task: options.task,
      selectedModel: options.selectedModel,
      onFallback: (_failedModel, nextModel) => {
        if (lastAttemptHadOutput) {
          options.onReset?.(nextModel);
        }
        lastAttemptHadOutput = false;
      }
    }, async (model) => {
      const stream = await this.getClient().chat.completions.create({
        model,
        messages: options.messages,
        stream: true,
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        response_format: options.responseFormat
      } as any, options.requestOptions as any);

      let fullResponse = '';
      let usage: TokenUsage | undefined;

      for await (const chunk of stream as any) {
        const text = chunk.choices?.[0]?.delta?.content || '';
        const chunkUsage = this.extractUsage(chunk);
        if (chunkUsage) {
          usage = chunkUsage;
        }
        if (text) {
          lastAttemptHadOutput = true;
          fullResponse += text;
          options.onChunk(text);
        }
      }

      return {
        value: fullResponse,
        tokens: usage || this.estimateUsage(options.messages, fullResponse)
      };
    });
  }

  private flattenContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  private extractUsage(payload: any): TokenUsage | undefined {
    const usage = payload?.usage || payload?.x_groq?.usage;
    if (!usage) return undefined;
    return {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens
    };
  }

  private estimateUsage(messages: ChatCompletionMessageParam[], response: string): TokenUsage {
    const promptTokens = Math.ceil(JSON.stringify(messages).length / 4);
    const completionTokens = Math.ceil(response.length / 4);
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      estimated: true
    };
  }
}
