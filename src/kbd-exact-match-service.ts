import { createHash } from 'crypto';
import * as fs from 'fs-extra';
import * as path from 'path';
import { documentProcessor } from './document-processor';
import { getKbdDirectory } from './main/folderManager';

const KBD_MIN_MATCH_SCORE = 0.8;

export interface KBDExactMatch {
  answer: string;
  fileName: string;
  matchedQuestion: string;
  matchScore: number;
  recordId?: string;
}

export interface KBDQuestionRecord {
  id: string;
  answer: string;
  fileName: string;
  question: string;
}

interface QAEntry {
  answer: string;
  fileName: string;
  question: string;
}

export class KBDExactMatchService {
  private cachedEntries: QAEntry[] | null = null;
  private cacheSignature = '';
  private cachePromise: Promise<QAEntry[]> | null = null;

  async warmCache(force = false): Promise<void> {
    await this.loadEntries(force);
  }

  invalidateCache(): void {
    this.cachedEntries = null;
    this.cacheSignature = '';
    this.cachePromise = null;
  }

  async getAllEntries(force = false): Promise<KBDQuestionRecord[]> {
    const entries = await this.loadEntries(force);
    return entries.map((entry, index) => this.addRecordId(entry, index));
  }

  async getEntryById(id: string, force = false): Promise<KBDQuestionRecord | null> {
    const entries = await this.getAllEntries(force);
    return entries.find(entry => entry.id === id) || null;
  }

  findCachedExactMatch(question: string): KBDExactMatch | null {
    if (!this.cachedEntries) return null;
    return this.findBestMatch(question, this.cachedEntries);
  }

  async findExactMatch(question: string): Promise<KBDExactMatch | null> {
    const cachedMatch = this.findCachedExactMatch(question);
    if (cachedMatch) return cachedMatch;

    const entries = await this.loadEntries();
    return this.findBestMatch(question, entries);
  }

  private findBestMatch(question: string, entries: QAEntry[]): KBDExactMatch | null {
    const normalizedQuestion = this.normalize(question);
    if (!normalizedQuestion) return null;
    if (!entries.length) return null;

    let bestMatch: (KBDExactMatch & { rawScore: number }) | null = null;

    for (const [index, entry] of entries.entries()) {
      const score = this.computeSimilarity(normalizedQuestion, this.normalize(entry.question));
      if (!bestMatch || score > bestMatch.rawScore) {
        bestMatch = {
          answer: entry.answer,
          fileName: entry.fileName,
          matchedQuestion: entry.question,
          matchScore: Math.round(score * 100),
          recordId: this.createRecordId(entry, index),
          rawScore: score
        };
      }
    }

    if (!bestMatch || bestMatch.rawScore < KBD_MIN_MATCH_SCORE) {
      return null;
    }

    return {
      answer: bestMatch.answer,
      fileName: bestMatch.fileName,
      matchedQuestion: bestMatch.matchedQuestion,
      matchScore: bestMatch.matchScore,
      recordId: bestMatch.recordId
    };
  }

  private async loadEntries(force = false): Promise<QAEntry[]> {
    if (this.cachePromise) return this.cachePromise;

    this.cachePromise = this.loadEntriesFresh(force).finally(() => {
      this.cachePromise = null;
    });

    return this.cachePromise;
  }

  private async loadEntriesFresh(force: boolean): Promise<QAEntry[]> {
    const folder = this.resolveKBFolder();
    const exists = await fs.pathExists(folder);
    if (!exists) {
      this.cachedEntries = [];
      this.cacheSignature = '';
      return [];
    }

    const fileNames = (await fs.readdir(folder)).sort((a, b) => a.localeCompare(b));
    const files: Array<{ fileName: string; filePath: string; signaturePart: string }> = [];

    for (const fileName of fileNames) {
      const filePath = path.join(folder, fileName);
      const stats = await fs.stat(filePath).catch(() => null);
      if (!stats?.isFile()) continue;

      const ext = path.extname(fileName).toLowerCase();
      if (!['.txt', '.md', '.markdown', '.doc', '.docx', '.pdf'].includes(ext)) continue;

      files.push({
        fileName,
        filePath,
        signaturePart: `${fileName}:${stats.size}:${stats.mtimeMs}`
      });
    }

    const nextSignature = files
      .map(file => file.signaturePart)
      .sort()
      .join('|');

    if (!force && this.cachedEntries && nextSignature === this.cacheSignature) {
      return this.cachedEntries;
    }

    const entries: QAEntry[] = [];

    for (const file of files) {
      try {
        const text = await documentProcessor.extractText(file.filePath);
        const extractedEntries = this.extractQAEntries(text, file.fileName);
        if (extractedEntries.length) {
          entries.push(...extractedEntries);
        } else {
          entries.push(...this.extractImplicitEntries(text, file.fileName));
        }
      } catch (error) {
        console.warn(`KBD Exact Match: Failed to read ${file.fileName}:`, error);
      }
    }

    this.cachedEntries = entries;
    this.cacheSignature = nextSignature;
    return entries;
  }

  private addRecordId(entry: QAEntry, index: number): KBDQuestionRecord {
    return {
      ...entry,
      id: this.createRecordId(entry, index)
    };
  }

  private createRecordId(entry: QAEntry, index: number): string {
    const key = `${entry.fileName}|${index}|${entry.question}|${entry.answer}`;
    return createHash('sha256').update(key).digest('hex').slice(0, 16);
  }

  private extractQAEntries(text: string, fileName: string): QAEntry[] {
    const normalized = this.normalizeLineBreaks(text);
    const lines = normalized.split('\n');
    const entries: QAEntry[] = [];

    let i = 0;
    while (i < lines.length) {
      const question = this.extractQuestionLine(lines[i]);
      if (!question) {
        i++;
        continue;
      }

      i++;

      while (i < lines.length && !lines[i].trim()) i++;

      const answerParts: string[] = [];
      let answerStarted = false;

      while (i < lines.length) {
        const nextQuestion = this.extractQuestionLine(lines[i]);
        if (nextQuestion && answerStarted) break;

        const answerMatch = lines[i].match(/^\s*(?:a|answer)\s*[:.-]?\s*(.*)$/i);
        if (answerMatch) {
          answerStarted = true;
          if (answerMatch[1]) answerParts.push(answerMatch[1]);
          i++;
          continue;
        }

        if (!answerStarted) {
          answerStarted = true;
        }

        answerParts.push(lines[i]);
        i++;
      }

      const answer = answerParts.join('\n').trim();
      if (question && answer) {
        entries.push({ question, answer, fileName });
      }
    }

    return entries;
  }

  private extractImplicitEntries(text: string, fileName: string): QAEntry[] {
    const normalizedText = this.normalizeLineBreaks(text).trim();
    if (!normalizedText) return [];

    const normalizedFileName = path.basename(fileName, path.extname(fileName)).toLowerCase();
    if (/(self\s*introduction|introduction|introduce\s*yourself|about\s*yourself)/i.test(normalizedFileName)) {
      return [
        'Tell me about yourself',
        'Introduce yourself',
        'Walk me through your background',
        'Give me a quick introduction about yourself'
      ].map(question => ({
        question,
        answer: normalizedText,
        fileName
      }));
    }

    return [];
  }

  private extractQuestionLine(line: string): string | null {
    const match = line.match(/^\s*(?:q|question)\s*(?:[.\-#]?\s*\d+)?\s*[:.\-]+\s*(.+?)\s*$/i);
    if (!match) return null;

    return match[1]
      .replace(/^["'“”]+/, '')
      .replace(/["'“”]+$/, '')
      .trim();
  }

  private computeSimilarity(left: string, right: string): number {
    if (!left || !right) return 0;
    if (left === right) return 1;
    if (left.includes(right) || right.includes(left)) return 0.95;

    const leftTokens = this.tokenize(left);
    const rightTokens = this.tokenize(right);
    if (!leftTokens.length || !rightTokens.length) return 0;

    const cosine = this.cosineSimilarity(leftTokens, rightTokens);
    const coverage = this.coverageScore(leftTokens, rightTokens);
    const phraseBoost = this.sharedPhraseScore(left, right);
    const tokenOrder = this.tokenOrderSimilarity(leftTokens, rightTokens);
    const editSimilarity = this.normalizedEditSimilarity(left, right);

    return Math.max(
      phraseBoost,
      (cosine * 0.4) + (coverage * 0.2) + (tokenOrder * 0.2) + (editSimilarity * 0.2)
    );
  }

  private cosineSimilarity(leftTokens: string[], rightTokens: string[]): number {
    const leftCounts = this.countTokens(leftTokens);
    const rightCounts = this.countTokens(rightTokens);
    const tokenSet = new Set([...leftCounts.keys(), ...rightCounts.keys()]);

    let dot = 0;
    let leftMag = 0;
    let rightMag = 0;

    for (const token of tokenSet) {
      const leftValue = leftCounts.get(token) || 0;
      const rightValue = rightCounts.get(token) || 0;
      dot += leftValue * rightValue;
      leftMag += leftValue * leftValue;
      rightMag += rightValue * rightValue;
    }

    if (!leftMag || !rightMag) return 0;
    return dot / (Math.sqrt(leftMag) * Math.sqrt(rightMag));
  }

  private coverageScore(leftTokens: string[], rightTokens: string[]): number {
    const leftSet = new Set(leftTokens);
    const rightSet = new Set(rightTokens);
    let common = 0;

    for (const token of leftSet) {
      if (rightSet.has(token)) common++;
    }

    return common / Math.max(leftSet.size, rightSet.size, 1);
  }

  private sharedPhraseScore(left: string, right: string): number {
    const leftWords = left.split(' ');
    const rightWords = right.split(' ');
    const minLength = Math.min(leftWords.length, rightWords.length);

    if (minLength < 4) return 0;

    for (let size = Math.min(8, minLength); size >= 4; size--) {
      const phrases = new Set<string>();
      for (let i = 0; i <= leftWords.length - size; i++) {
        phrases.add(leftWords.slice(i, i + size).join(' '));
      }

      for (let i = 0; i <= rightWords.length - size; i++) {
        const phrase = rightWords.slice(i, i + size).join(' ');
        if (phrases.has(phrase)) {
          return size >= 6 ? 0.93 : 0.88;
        }
      }
    }

    return 0;
  }

  private tokenOrderSimilarity(leftTokens: string[], rightTokens: string[]): number {
    const leftJoined = leftTokens.join(' ');
    const rightJoined = rightTokens.join(' ');
    if (!leftJoined || !rightJoined) return 0;

    return this.normalizedEditSimilarity(leftJoined, rightJoined);
  }

  private normalizedEditSimilarity(left: string, right: string): number {
    const maxLength = Math.max(left.length, right.length);
    if (!maxLength) return 1;

    const distance = this.levenshteinDistance(left, right);
    return 1 - (distance / maxLength);
  }

  private levenshteinDistance(left: string, right: string): number {
    const rows = left.length + 1;
    const cols = right.length + 1;
    const matrix: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));

    for (let row = 0; row < rows; row++) matrix[row][0] = row;
    for (let col = 0; col < cols; col++) matrix[0][col] = col;

    for (let row = 1; row < rows; row++) {
      for (let col = 1; col < cols; col++) {
        const substitutionCost = left[row - 1] === right[col - 1] ? 0 : 1;
        matrix[row][col] = Math.min(
          matrix[row - 1][col] + 1,
          matrix[row][col - 1] + 1,
          matrix[row - 1][col - 1] + substitutionCost
        );
      }
    }

    return matrix[rows - 1][cols - 1];
  }

  private countTokens(tokens: string[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const token of tokens) {
      counts.set(token, (counts.get(token) || 0) + 1);
    }
    return counts;
  }

  private tokenize(text: string): string[] {
    const stopWords = new Set([
      'a', 'an', 'and', 'are', 'about', 'can', 'could', 'do', 'did', 'does',
      'explain', 'for', 'give', 'how', 'i', 'if', 'in', 'is', 'it', 'me',
      'of', 'on', 'please', 'tell', 'the', 'to', 'us', 'what', 'when', 'why',
      'would', 'you', 'your'
    ]);

    return text
      .split(' ')
      .map(token => this.normalizeToken(token.trim()))
      .filter(token => token && !stopWords.has(token));
  }

  private normalizeToken(token: string): string {
    if (token.length <= 3) return token;
    if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
    if (token.endsWith('s') && !token.endsWith('ss') && token.length > 4) return token.slice(0, -1);
    return token;
  }

  private normalize(text: string): string {
    return this.normalizeLineBreaks(text)
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private normalizeLineBreaks(text: string): string {
    return String(text || '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');
  }

  private resolveKBFolder(): string {
    return getKbdDirectory();
  }
}

export const kbdExactMatchService = new KBDExactMatchService();
