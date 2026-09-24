import type { DocumentSource, SourceDocumentInput } from './knowledge-types';

export interface DocumentChunk {
  id: string;
  text: string;
  source: DocumentSource;
  fileName: string;
  vector?: number[];
}

export interface ScoredDocumentChunk {
  chunk: DocumentChunk;
  score: number;
}

export class EmbeddingService {
  private chunks: DocumentChunk[] = [];
  private vocabulary: Map<string, number> = new Map();

  async clearStore() {
    this.chunks = [];
    this.vocabulary.clear();
  }

  async addDocument(
    text: string,
    source: DocumentSource,
    fileName: string,
    options: { deferRebuild?: boolean } = {}
  ) {
    const newChunks = this.chunkText(text, 500); // 500 chars chunks
    for (const chunkText of newChunks) {
      this.chunks.push({
        id: Math.random().toString(36).substr(2, 9),
        text: chunkText,
        source,
        fileName
      });
    }
    if (!options.deferRebuild) {
      this.rebuildIndex();
    }
  }

  async addDocuments(documents: SourceDocumentInput[]) {
    if (!documents.length) return;

    for (const document of documents) {
      await this.addDocument(document.text, document.source, document.fileName, { deferRebuild: true });
    }

    this.rebuildIndex();
  }

  async clearSource(source: DocumentSource, options: { deferRebuild?: boolean } = {}) {
    const nextChunks = this.chunks.filter(chunk => chunk.source !== source);
    if (nextChunks.length === this.chunks.length) return;
    this.chunks = nextChunks;
    if (!options.deferRebuild) {
      this.rebuildIndex();
    }
  }

  private chunkText(text: string, size: number): string[] {
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
      let end = start + size;
      if (end < text.length) {
        // Try to find last space to avoid cutting words
        const lastSpace = text.lastIndexOf(' ', end);
        if (lastSpace > start) end = lastSpace;
      }
      chunks.push(text.substring(start, end).trim());
      start = end;
    }
    return chunks;
  }

  private rebuildIndex() {
    // Basic TF-IDF Vectorization
    const allWords = new Set<string>();
    this.chunks.forEach(c => {
      this.getWords(c.text).forEach(w => allWords.add(w));
    });

    const vocabList = Array.from(allWords);
    this.vocabulary.clear();
    vocabList.forEach((w, i) => this.vocabulary.set(w, i));

    this.chunks.forEach(c => {
      c.vector = this.vectorize(c.text);
    });
  }

  private getWords(text: string): string[] {
    return text.toLowerCase().match(/\w+/g) || [];
  }

  private vectorize(text: string): number[] {
    const vec = new Array(this.vocabulary.size).fill(0);
    const words = this.getWords(text);
    words.forEach(w => {
      if (this.vocabulary.has(w)) {
        vec[this.vocabulary.get(w)!]++;
      }
    });
    // Normalize
    const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    return magnitude > 0 ? vec.map(v => v / magnitude) : vec;
  }

  async similaritySearch(query: string, limit: number = 3, filterSource?: string): Promise<DocumentChunk[]> {
    const results = await this.scoredSimilaritySearch(query, limit, filterSource);
    return results.map(result => result.chunk);
  }

  async scoredSimilaritySearch(
    query: string,
    limit: number = 3,
    filterSource?: string,
    minScore: number = 0
  ): Promise<ScoredDocumentChunk[]> {
    const queryVec = this.vectorize(query);
    const results = this.chunks
      .filter(c => !filterSource || c.source === filterSource)
      .map(c => ({
        chunk: c,
        score: this.cosineSimilarity(queryVec, c.vector!)
      }))
      .filter(result => result.score > minScore)
      .sort((a, b) => b.score - a.score);

    return results.slice(0, limit);
  }

  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0;
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
    }
    return dotProduct;
  }

  getChunksBySource(source: DocumentSource): DocumentChunk[] {
    return this.chunks.filter(c => c.source === source);
  }
}

export const embeddingService = new EmbeddingService();
