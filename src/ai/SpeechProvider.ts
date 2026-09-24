import Groq, { toFile } from 'groq-sdk';

import { ModelManager, TokenUsage } from './ModelManager';

export interface SpeechTranscriptionOptions {
  task: string;
  selectedModel?: string;
  mimeType: string;
  prompt?: string;
}

export class SpeechProvider {
  constructor(
    private readonly getClient: () => Groq,
    private readonly modelManager: ModelManager
  ) {}

  async transcribe(audioBuffer: Buffer, options: SpeechTranscriptionOptions): Promise<string> {
    return this.modelManager.runWithFallback<string>({
      capability: 'speech',
      task: options.task,
      selectedModel: options.selectedModel
    }, async (model) => {
      const file = await toFile(audioBuffer, this.getFileName(options.mimeType), { type: options.mimeType });
      const response: any = await this.getClient().audio.transcriptions.create({
        file,
        model,
        prompt: options.prompt,
        response_format: 'json',
        temperature: 0
      } as any);

      const text = String(response?.text || '').trim();
      return {
        value: text,
        tokens: this.estimateUsage(text)
      };
    });
  }

  private getFileName(mimeType: string): string {
    if (/webm/i.test(mimeType)) return 'speech.webm';
    if (/ogg/i.test(mimeType)) return 'speech.ogg';
    if (/mpeg|mp3/i.test(mimeType)) return 'speech.mp3';
    if (/mp4/i.test(mimeType)) return 'speech.mp4';
    return 'speech.wav';
  }

  private estimateUsage(text: string): TokenUsage {
    const totalTokens = Math.ceil(text.length / 4);
    return {
      completionTokens: totalTokens,
      totalTokens,
      estimated: true
    };
  }
}
