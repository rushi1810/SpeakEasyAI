import { app } from 'electron';
import * as fs from 'fs-extra';
import * as path from 'path';

import { documentProcessor } from './document-processor';
import { embeddingService, ScoredDocumentChunk } from './embedding-service';
import { aiModelManager } from './ai/ModelManager';

const CACHE_VERSION = 1;
const SUPPORTED_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.txt', '.md', '.markdown',
  '.sql', '.csv', '.json', '.yaml', '.yml',
  '.png', '.jpg', '.jpeg', '.jfif', '.webp', '.bmp'
]);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.jfif', '.webp', '.bmp']);
const SQL_DIRECT_ANSWER_MAX_CHARS = 650;

interface DatasetFileRecord {
  fileName: string;
  relativePath: string;
  signature: string;
  text: string;
  usedOcr: boolean;
}

interface DatasetCache {
  version: number;
  updatedAt: number;
  files: Record<string, DatasetFileRecord>;
}

interface DatasetScanFile {
  filePath: string;
  relativePath: string;
  signature: string;
}

export interface SqlDatasetStatus {
  available: boolean;
  indexedDocuments: number;
  indexedChunks: number;
  lastIndexedAt: number | null;
  pendingOcrFiles: number;
  rootPath: string;
  skippedFiles: number;
  sourceFiles: string[];
}

export interface SqlDirectAnswer {
  answer: string;
  fileName: string;
  score: number;
}

export interface SqlRetrievalResult {
  context: string;
  preferSqlDataset: boolean;
  topMatches: ScoredDocumentChunk[];
}

export class SqlKnowledgeService {
  private status: SqlDatasetStatus = {
    available: false,
    indexedDocuments: 0,
    indexedChunks: 0,
    lastIndexedAt: null,
    pendingOcrFiles: 0,
    rootPath: '',
    skippedFiles: 0,
    sourceFiles: []
  };

  getStatus(): SqlDatasetStatus {
    return { ...this.status, sourceFiles: [...this.status.sourceFiles] };
  }

  resolveDatasetRoot(): string {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    const candidates = [
      path.join(__dirname, '..', 'data_set'),
      path.join(app.getPath('userData'), 'data_set'),
      resourcesPath ? path.join(resourcesPath, 'data_set') : '',
      path.join(app.getAppPath(), 'data_set')
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return candidates[0];
  }

  async indexDataset(force = false): Promise<SqlDatasetStatus> {
    const rootPath = this.resolveDatasetRoot();
    await embeddingService.clearSource('sql');

    const available = await fs.pathExists(rootPath);
    if (!available) {
      this.status = {
        available: false,
        indexedDocuments: 0,
        indexedChunks: 0,
        lastIndexedAt: Date.now(),
        pendingOcrFiles: 0,
        rootPath,
        skippedFiles: 0,
        sourceFiles: []
      };
      return this.getStatus();
    }

    const files = await this.collectSupportedFiles(rootPath);
    const cache = await this.readCache();
    const nextCacheFiles: Record<string, DatasetFileRecord> = {};
    const documentsToAdd: Array<{ fileName: string; text: string; source: 'sql' }> = [];
    const visionModel = aiModelManager.getVisionModel();
    let skippedFiles = 0;
    let pendingOcrFiles = 0;

    for (const file of files) {
      const cached = !force ? cache.files[file.relativePath] : undefined;
      let text = '';
      let usedOcr = false;

      if (cached && cached.signature === file.signature && cached.text.trim()) {
        text = cached.text;
        usedOcr = cached.usedOcr;
      } else {
        try {
          text = await documentProcessor.extractText(file.filePath, {
            allowImageOcr: true,
            visionModel
          });
          usedOcr = this.isImageFile(file.filePath);
        } catch (error: any) {
          if (this.isImageFile(file.filePath) && /ocr|api key|vision/i.test(String(error?.message || ''))) {
            pendingOcrFiles++;
          } else {
            skippedFiles++;
          }
          continue;
        }
      }

      const normalizedText = String(text || '').trim();
      if (normalizedText.length < 20) {
        skippedFiles++;
        continue;
      }

      const fileName = file.relativePath.replace(/\\/g, '/');
      documentsToAdd.push({
        text: normalizedText,
        source: 'sql',
        fileName
      });

      nextCacheFiles[file.relativePath] = {
        fileName,
        relativePath: file.relativePath,
        signature: file.signature,
        text: normalizedText,
        usedOcr
      };
    }

    await embeddingService.addDocuments(documentsToAdd);
    await this.writeCache({
      version: CACHE_VERSION,
      updatedAt: Date.now(),
      files: nextCacheFiles
    });

    this.status = {
      available: true,
      indexedDocuments: documentsToAdd.length,
      indexedChunks: embeddingService.getChunksBySource('sql').length,
      lastIndexedAt: Date.now(),
      pendingOcrFiles,
      rootPath,
      skippedFiles,
      sourceFiles: documentsToAdd.map(document => document.fileName)
    };

    return this.getStatus();
  }

  isSqlQuestion(query: string): boolean {
    const normalized = this.normalize(query);
    if (!normalized) return false;

    return /\b(sql|mysql|postgres|postgresql|oracle|pl sql|t sql|tsql|sql server|database|dbms|rdbms|query|table|schema|join|inner join|left join|right join|full join|cross join|self join|subquery|cte|common table expression|window function|rank|dense_rank|row_number|partition by|group by|having|order by|where clause|select|insert|update|delete|merge|truncate|union|intersect|except|index|primary key|foreign key|constraint|normalization|1nf|2nf|3nf|acid|transaction|commit|rollback|savepoint|aggregate|count|sum|avg|min|max|varchar|nvarchar|char|int|decimal|stored procedure|trigger|view|cursor|etl)\b/.test(normalized);
  }

  async retrieveContext(query: string): Promise<SqlRetrievalResult> {
    const topMatches = await embeddingService.scoredSimilaritySearch(query, 5, 'sql', 0.01);

    return {
      context: this.joinChunks(topMatches, 1800),
      preferSqlDataset: Boolean(topMatches[0] && topMatches[0].score >= 0.02),
      topMatches
    };
  }

  async findDirectAnswer(query: string): Promise<SqlDirectAnswer | null> {
    const topMatches = await embeddingService.scoredSimilaritySearch(query, 3, 'sql', 0.01);
    const bestMatch = topMatches[0];
    if (!bestMatch) return null;

    const answer = bestMatch.chunk.text.replace(/\s+/g, ' ').trim();
    if (!answer || answer.length > SQL_DIRECT_ANSWER_MAX_CHARS) {
      return null;
    }

    const lexicalCoverage = this.calculateKeywordCoverage(query, answer);
    const phraseScore = this.calculatePhraseScore(query, answer);
    const scoreGap = bestMatch.score - (topMatches[1]?.score || 0);
    const isDefinitionStyle = /\b(what is|define|difference between|syntax|meaning of|types of|list of|explain)\b/i.test(query);
    const strongDirectMatch = lexicalCoverage >= 0.78 && (phraseScore >= 0.22 || scoreGap >= 0.012);
    const safeDefinitionMatch = isDefinitionStyle && lexicalCoverage >= 0.64 && phraseScore >= 0.16 && answer.length <= 420;

    if (!strongDirectMatch && !safeDefinitionMatch) {
      return null;
    }

    return {
      answer,
      fileName: bestMatch.chunk.fileName,
      score: Math.round(Math.max(bestMatch.score, lexicalCoverage, phraseScore) * 100)
    };
  }

  private async collectSupportedFiles(rootPath: string, currentDir = rootPath): Promise<DatasetScanFile[]> {
    const entries = await fs.readdir(currentDir);
    const files: DatasetScanFile[] = [];

    for (const entry of entries) {
      const filePath = path.join(currentDir, entry);
      const stats = await fs.stat(filePath).catch(() => null);
      if (!stats) continue;

      if (stats.isDirectory()) {
        files.push(...await this.collectSupportedFiles(rootPath, filePath));
        continue;
      }

      const ext = path.extname(entry).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

      const relativePath = path.relative(rootPath, filePath);
      files.push({
        filePath,
        relativePath,
        signature: `${relativePath}:${stats.size}:${stats.mtimeMs}`
      });
    }

    return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  private calculateKeywordCoverage(query: string, answer: string): number {
    const queryTokens = this.tokenize(query);
    if (!queryTokens.length) return 0;

    const answerTokenSet = new Set(this.tokenize(answer));
    let overlap = 0;

    for (const token of queryTokens) {
      if (answerTokenSet.has(token)) {
        overlap++;
      }
    }

    return overlap / queryTokens.length;
  }

  private calculatePhraseScore(query: string, answer: string): number {
    const queryText = this.normalize(query);
    const answerText = this.normalize(answer);
    if (!queryText || !answerText) return 0;

    if (answerText.includes(queryText) || queryText.includes(answerText)) {
      return 1;
    }

    const queryWords = queryText.split(' ').filter(Boolean);
    if (queryWords.length < 2) return 0;

    let bestScore = 0;
    for (let size = Math.min(5, queryWords.length); size >= 2; size--) {
      for (let index = 0; index <= queryWords.length - size; index++) {
        const phrase = queryWords.slice(index, index + size).join(' ');
        if (answerText.includes(phrase)) {
          bestScore = Math.max(bestScore, size / queryWords.length);
        }
      }
    }

    return bestScore;
  }

  private tokenize(text: string): string[] {
    const stopWords = new Set([
      'a', 'an', 'and', 'are', 'be', 'by', 'can', 'difference', 'do', 'does', 'explain',
      'for', 'how', 'i', 'in', 'is', 'it', 'of', 'or', 'please', 'tell', 'the', 'to',
      'what', 'when', 'where', 'which', 'why'
    ]);

    return this.normalize(text)
      .split(' ')
      .filter(token => token.length > 1 && !stopWords.has(token));
  }

  private normalize(text: string): string {
    return String(text || '')
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private joinChunks(results: ScoredDocumentChunk[], maxChars: number): string {
    if (!results.length || maxChars <= 0) return '';

    const parts: string[] = [];
    let used = 0;

    for (const result of results) {
      const raw = `[From ${result.chunk.fileName}]: ${result.chunk.text}`.trim();
      if (!raw) continue;

      const remaining = maxChars - used;
      if (remaining <= 0) break;

      const nextPart = raw.length > remaining
        ? `${raw.slice(0, Math.max(0, remaining - 3)).trim()}...`
        : raw;

      if (!nextPart) break;
      parts.push(nextPart);
      used += nextPart.length + 2;
    }

    return parts.join('\n\n');
  }

  private isImageFile(filePath: string): boolean {
    return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  }

  private getCachePath(): string {
    return path.join(app.getPath('userData'), 'training-cache', 'sql-dataset-cache.json');
  }

  private async readCache(): Promise<DatasetCache> {
    const cachePath = this.getCachePath();
    if (!await fs.pathExists(cachePath)) {
      return {
        version: CACHE_VERSION,
        updatedAt: 0,
        files: {}
      };
    }

    try {
      const parsed = await fs.readJson(cachePath) as DatasetCache;
      if (parsed.version !== CACHE_VERSION || !parsed.files) {
        throw new Error('Cache version mismatch');
      }
      return parsed;
    } catch {
      return {
        version: CACHE_VERSION,
        updatedAt: 0,
        files: {}
      };
    }
  }

  private async writeCache(cache: DatasetCache): Promise<void> {
    const cachePath = this.getCachePath();
    await fs.ensureDir(path.dirname(cachePath));
    await fs.writeJson(cachePath, cache, { spaces: 2 });
  }
}

export const sqlKnowledgeService = new SqlKnowledgeService();
