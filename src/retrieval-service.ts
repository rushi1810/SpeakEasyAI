import { embeddingService, ScoredDocumentChunk } from './embedding-service';
import { sqlKnowledgeService, SqlDatasetStatus } from './sql-knowledge-service';

export interface RetrievalResult {
  resumeContext: string;
  jdContext: string;
  kbContext: string;
  sqlContext: string;
  useResumeContext: boolean;
  preferKnowledgeBase: boolean;
  preferSqlDataset: boolean;
  isSqlQuestion: boolean;
}

export class RetrievalService {
  async retrieveContext(query: string): Promise<RetrievalResult> {
    const useResumeContext = this.shouldUseResumeContext(query);
    const introQuestion = this.isIntroductionQuestion(query);
    const behavioralQuestion = this.isBehavioralQuestion(query);
    const technicalQuestion = this.isTechnicalQuestion(query);
    const isSqlQuestion = sqlKnowledgeService.isSqlQuestion(query);
    const kbLimit = introQuestion || behavioralQuestion ? 3 : technicalQuestion ? 4 : 3;

    const resumePromise = useResumeContext
      ? this.getResumeChunks(query)
      : Promise.resolve([]);
    const jdPromise = introQuestion
      ? embeddingService.scoredSimilaritySearch(query, 1, 'jd', 0.01)
      : embeddingService.scoredSimilaritySearch(query, 2, 'jd', 0.01);
    const kbPromise = embeddingService.scoredSimilaritySearch(query, kbLimit, 'kb', 0.015);
    const sqlPromise = isSqlQuestion
      ? sqlKnowledgeService.retrieveContext(query)
      : Promise.resolve({ context: '', preferSqlDataset: false, topMatches: [] as ScoredDocumentChunk[] });

    const [resumeChunks, jdChunks, kbChunks, sqlResult] = await Promise.all([
      resumePromise,
      jdPromise,
      kbPromise,
      sqlPromise
    ]);
    const preferKnowledgeBase = this.shouldPreferKnowledgeBase(
      query,
      kbChunks,
      introQuestion,
      behavioralQuestion,
      technicalQuestion
    ) && !sqlResult.preferSqlDataset;

    return {
      resumeContext: this.joinChunks(resumeChunks, true, 1200),
      jdContext: this.joinChunks(jdChunks, false, 850),
      kbContext: this.joinChunks(kbChunks, true, preferKnowledgeBase ? 1800 : technicalQuestion ? 1200 : 700),
      sqlContext: sqlResult.context,
      useResumeContext,
      preferKnowledgeBase,
      preferSqlDataset: sqlResult.preferSqlDataset,
      isSqlQuestion
    };
  }

  getAllSources(): { resume: string[], jd: string[], kb: string[], sql: string[], sqlStatus: SqlDatasetStatus } {
    const resume = Array.from(new Set(embeddingService.getChunksBySource('resume').map(c => c.fileName)));
    const jd = Array.from(new Set(embeddingService.getChunksBySource('jd').map(c => c.fileName)));
    const kb = Array.from(new Set(embeddingService.getChunksBySource('kb').map(c => c.fileName)));
    const sql = Array.from(new Set(embeddingService.getChunksBySource('sql').map(c => c.fileName)));

    return {
      resume,
      jd,
      kb,
      sql,
      sqlStatus: sqlKnowledgeService.getStatus()
    };
  }

  private async getResumeChunks(query: string): Promise<ScoredDocumentChunk[]> {
    if (this.isIntroductionQuestion(query)) {
      return this.getLatestResumeOpeningChunks(3);
    }

    const directMatches = await embeddingService.scoredSimilaritySearch(query, 2, 'resume', 0.02);
    return directMatches;
  }

  private isIntroductionQuestion(query: string): boolean {
    const normalized = query.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!normalized) return false;

    return /\b(introduce yourself|tell me about yourself|tell us about yourself|brief me about yourself|brief about yourself|brief your self|brief myself|give me a quick intro|walk me through your background|share your background)\b/.test(normalized);
  }

  private isBehavioralQuestion(query: string): boolean {
    const normalized = query.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!normalized) return false;

    return /\b(tell me about a time|describe a time|give me an example|example of when|how did you handle|challenge|conflict|failure|mistake|leadership|proud|achievement|accomplishment|strength|weakness)\b/.test(normalized);
  }

  private isTechnicalQuestion(query: string): boolean {
    const normalized = query.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!normalized) return false;

    return /\b(code|coding|algorithm|complexity|function|class|array|string|linked list|tree|graph|sql|query|database|implement|debug|bug|binary|stack|queue|api|microservice|architecture|system design|scalability|latency|cache|kubernetes|docker|ci\/cd|cloud|aws|azure|gcp|devops|design|etl|elt|cdc|batch|real[-\s]?time|streaming|pipeline|orchestration|airflow|dbt|snowflake|bigquery|redshift|databricks|delta lake|data lake|data warehouse|warehouse|fivetran|hvr|kafka|spark|bronze|silver|gold)\b/.test(normalized);
  }

  private getLatestResumeOpeningChunks(limit: number): ScoredDocumentChunk[] {
    const resumeChunks = embeddingService.getChunksBySource('resume');
    if (!resumeChunks.length) return [];

    const latestFileName = resumeChunks[resumeChunks.length - 1].fileName;
    return resumeChunks
      .filter(chunk => chunk.fileName === latestFileName)
      .slice(0, limit)
      .map((chunk, index) => ({
        chunk,
        score: 1 - index * 0.01
      }));
  }

  private shouldPreferKnowledgeBase(
    query: string,
    kbChunks: ScoredDocumentChunk[],
    introQuestion: boolean,
    behavioralQuestion: boolean,
    technicalQuestion: boolean
  ): boolean {
    if (!kbChunks.length) return false;

    const normalized = query.toLowerCase().replace(/\s+/g, ' ').trim();
    const topScore = kbChunks[0]?.score || 0;
    const directKnowledgeCue = /\b(project|architecture|design|workflow|steps|implementation|how it works|what do you do|day-to-day|day to day|responsibilities|current role|self introduction|introduce yourself|tell me about yourself|your project|your work|walk me through|explain your pipeline|fivetran|hvr|dbt|snowflake|hdfc)\b/;

    if (directKnowledgeCue.test(normalized)) return true;
    if ((introQuestion || behavioralQuestion) && topScore >= 0.03) return true;
    if (technicalQuestion && topScore >= 0.04) return true;
    return topScore >= 0.05;
  }

  private joinChunks(results: ScoredDocumentChunk[], includeFileName: boolean, maxChars: number): string {
    if (!results.length || maxChars <= 0) return '';

    const parts: string[] = [];
    let used = 0;

    for (const result of results) {
      const prefix = includeFileName ? `[From ${result.chunk.fileName}]: ` : '';
      const raw = `${prefix}${result.chunk.text}`.trim();
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

  private shouldUseResumeContext(query: string): boolean {
    const normalized = query.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!normalized) return false;

    const directResumeCue = /\b(resume|cv|background|about yourself|tell me about yourself|tell us about yourself|introduce yourself|brief me about yourself|brief about yourself|brief your self|brief myself|quick intro|career|journey|strength|weakness|achievement|accomplishment|leadership|conflict|mistake|failure|proud|challenge|project you worked on|project that you|time when|example of when|walk me through your background|tell me about a time|why should we hire you|why are you a good fit)\b/;
    const personalCue = /\b(your|you've|you have|have you|did you|were you|what did you|how did you|where did you|when did you|which project|what project|what was your role|how have you)\b/;
    const experienceCue = /\b(experience|background|career|role|project|projects|team|led|built|implemented|delivered|owned|handled|contributed|worked on|achieved|learned|solved|managed|improved|mentored)\b/;

    return directResumeCue.test(normalized) || (personalCue.test(normalized) && experienceCue.test(normalized));
  }
}

export const retrievalService = new RetrievalService();
