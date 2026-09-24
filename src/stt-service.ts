import { getSettings } from './store';
import { SpeechProvider } from './ai/SpeechProvider';
import { aiModelManager } from './ai/ModelManager';
import { getGroqClient, isGroqInitialized } from './groq';

export interface STTResult {
  success: boolean;
  text?: string;
  error?: string;
  provider?: string;
}

export interface STTOptions {
  mimeType?: string;
}

const speechProvider = new SpeechProvider(() => getGroqClient(), aiModelManager);

export async function transcribeWithGroq(audioBuffer: Buffer, options: STTOptions = {}): Promise<STTResult> {
  const settings = getSettings();
  const mimeType = options.mimeType || 'audio/wav';

  if (!isGroqInitialized()) {
    return { success: false, error: 'No Groq API Key' };
  }

  try {
    const text = await speechProvider.transcribe(audioBuffer, {
      task: 'Microphone Transcription',
      selectedModel: settings.speechModel,
      mimeType
    });
    return { success: true, text, provider: 'groq-whisper' };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
