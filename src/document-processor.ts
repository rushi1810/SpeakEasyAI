import * as fs from 'fs-extra';
import * as path from 'path';
const pdf = require('pdf-parse/node');
const mammoth = require('mammoth');

import { getGroqClient, isGroqInitialized } from './groq';
import { VisionProvider } from './ai/VisionProvider';
import { aiModelManager } from './ai/ModelManager';
import type { DocumentSource } from './knowledge-types';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.jfif', '.webp', '.bmp']);
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.sql', '.csv', '.json', '.yaml', '.yml']);
const visionProvider = new VisionProvider(() => getGroqClient(), aiModelManager);

export interface ProcessedDocument {
  text: string;
  source: DocumentSource;
  fileName: string;
}

export interface DocumentProcessingOptions {
  allowImageOcr?: boolean;
  visionModel?: string;
}

export class DocumentProcessor {
  async processFile(
    filePath: string,
    source: DocumentSource,
    options: DocumentProcessingOptions = {}
  ): Promise<ProcessedDocument> {
    const fileName = path.basename(filePath);

    try {
      const text = await this.extractText(filePath, options);

      return {
        text: this.cleanText(text),
        source,
        fileName
      };
    } catch (err: any) {
      throw new Error(`Failed to process ${fileName}: ${err.message}`);
    }
  }

  async extractText(filePath: string, options: DocumentProcessingOptions = {}): Promise<string> {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.pdf') {
      const dataBuffer = await fs.readFile(filePath);
      const data = await pdf(dataBuffer);
      return data.text || '';
    }

    if (ext === '.docx' || ext === '.doc') {
      const dataBuffer = await fs.readFile(filePath);
      const result = await mammoth.extractRawText({ buffer: dataBuffer });
      return result.value || '';
    }

    if (TEXT_EXTENSIONS.has(ext)) {
      return fs.readFile(filePath, 'utf-8');
    }

    if (IMAGE_EXTENSIONS.has(ext)) {
      return this.extractImageText(filePath, ext, options);
    }

    throw new Error(`Unsupported file type: ${ext}`);
  }

  private async extractImageText(
    filePath: string,
    ext: string,
    options: DocumentProcessingOptions
  ): Promise<string> {
    if (!options.allowImageOcr) {
      throw new Error(`Image OCR is disabled for ${path.basename(filePath)}`);
    }

    if (!isGroqInitialized()) {
      throw new Error('Image OCR requires a Groq API key in Settings');
    }

    const imageBuffer = await fs.readFile(filePath);
    const mimeType = this.getImageMimeType(ext);

    return visionProvider.complete({
      task: 'Document Image OCR',
      selectedModel: options.visionModel,
      messages: [
        {
          role: 'system',
          content: `You extract text from study materials.

Rules:
- Return only plain text.
- Preserve headings, bullets, formulas, and SQL snippets when they are visible.
- If the image is handwritten or messy, normalize spacing and line breaks for readability.
- Do not guess missing words. Omit unreadable fragments instead of inventing them.`
        },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${imageBuffer.toString('base64')}`
              }
            },
            {
              type: 'text',
              text: 'Extract all readable educational content from this image as plain text.'
            }
          ]
        }
      ],
      maxTokens: 2400,
      temperature: 0.1,
      requestOptions: {
        timeout: 120000,
        maxRetries: 0
      }
    });
  }

  private getImageMimeType(ext: string): string {
    switch (ext) {
      case '.png':
        return 'image/png';
      case '.webp':
        return 'image/webp';
      case '.bmp':
        return 'image/bmp';
      case '.jfif':
      case '.jpg':
      case '.jpeg':
      default:
        return 'image/jpeg';
    }
  }

  private cleanText(text: string): string {
    return String(text || '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }
}

export const documentProcessor = new DocumentProcessor();
