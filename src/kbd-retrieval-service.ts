import { KBDQuestionRecord, kbdExactMatchService } from './kbd-exact-match-service';

export interface KBDSearchResult extends KBDQuestionRecord {
  score: number;
  matchedBy: string[];
}

const STOP_WORDS = new Set([
  'a','about','an','and','any','are','as','at','be','been','being','between','but','by','can','could','do','does','for','from','have','how','if','in','into','is','it','its','just','like','many','me','more','most','of','on','or','our','out','over','she','should','so','some','such','than','that','the','their','them','then','there','these','they','this','those','through','to','too','under','up','use','used','using','very','was','we','what','when','where','which','who','why','will','with','would','you','your','yourself'
]);

function normalizeText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(/\s+/)
    .map(part => part.replace(/s$/i, ''))
    .filter(Boolean)
    .filter(token => token.length > 1 && !STOP_WORDS.has(token));
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const rows = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) rows[i][0] = i;
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + cost
      );
    }
  }

  return rows[a.length][b.length];
}

function fuzzyRatio(left: string, right: string): number {
  if (!left || !right) return 0;
  const maxLen = Math.max(left.length, right.length);
  if (!maxLen) return 0;
  const distance = levenshtein(left, right);
  return 1 - distance / maxLen;
}

function phoneticCode(value: string): string {
  const cleaned = normalizeText(value).replace(/[^a-z]/g, '');
  if (!cleaned) return '';

  const replacements: [RegExp, string][] = [
    [/ph/g, 'f'], [/kn/g, 'n'], [/wr/g, 'r'], [/sh/g, 'x'], [/ch/g, 'x'], [/th/g, '0'],
    [/gh/g, 'g'], [/qu/g, 'q'], [/ck/g, 'k'], [/c/g, 'k'], [/x/g, 'z'], [/v/g, 'f'],
    [/w/g, 'w'], [/y/g, 'y']
  ];

  let current = cleaned;
  for (const [pattern, replacement] of replacements) {
    current = current.replace(pattern, replacement);
  }

  const encoded: string[] = [];
  const map: Record<string, string> = { b: '1', f: '1', p: '1', v: '1', c: '2', g: '2', j: '2', k: '2', q: '2', s: '2', x: '2', z: '2', d: '3', t: '3', l: '4', m: '5', n: '5', r: '6', h: '7', w: '7', y: '7' };

  for (const char of current) {
    const code = map[char] ?? '';
    if (code && (!encoded.length || encoded[encoded.length - 1] !== code)) {
      encoded.push(code);
    }
  }

  let result = encoded.join('');
  if (result.length > 4) {
    result = result.slice(0, 4);
  }
  while (result.length < 4) {
    result += '0';
  }
  return result;
}

function phoneticSimilarity(left: string, right: string): number {
  const leftCode = phoneticCode(left);
  const rightCode = phoneticCode(right);
  if (!leftCode || !rightCode) return 0;
  if (leftCode === rightCode) return 1;
  const common = Math.max(0, Math.min(leftCode.length, rightCode.length) - levenshtein(leftCode, rightCode));
  return common / Math.max(leftCode.length, rightCode.length);
}

export class KBDRetrievalService {
  async getAllEntries(force = false): Promise<KBDQuestionRecord[]> {
    return kbdExactMatchService.getAllEntries(force);
  }

  async search(query: string, limit = 8): Promise<KBDSearchResult[]> {
    const normalizedQuery = normalizeText(query);
    if (!normalizedQuery) {
      return [];
    }

    const entries = await this.getAllEntries(true);
    if (!entries.length) {
      return [];
    }

    const results = entries
      .map(entry => {
        const question = normalizeText(entry.question);
        const answer = normalizeText(entry.answer);
        const score = this.scoreEntry(normalizedQuery, question, answer);
        return {
          ...entry,
          score,
          matchedBy: this.explainMatch(normalizedQuery, question, answer, score)
        };
      })
      .filter(item => item.score > 0.15)
      .sort((a, b) => b.score - a.score || a.question.localeCompare(b.question))
      .slice(0, limit);

    return results;
  }

  async getRelatedQuestions(query: string, limit = 8): Promise<KBDSearchResult[]> {
    const results = await this.search(query, limit);
    return results.filter(item => item.score >= 0.24);
  }

  private explainMatch(query: string, question: string, answer: string, score: number): string[] {
    const matches: string[] = [];
    if (!query) return matches;
    if (question === query || question.includes(query) || query.includes(question)) matches.push('exact');
    if (question.includes(query) || query.includes(question)) matches.push('partial');
    if (this.tokenOverlap(query, question) > 0.4) matches.push('token');
    if (fuzzyRatio(question, query) >= 0.7) matches.push('fuzzy');
    if (phoneticSimilarity(question, query) >= 0.6) matches.push('phonetic');
    if (this.tokenOverlap(query, answer) > 0.2) matches.push('answer');
    return matches.length ? matches : ['semantic'];
  }

  private scoreEntry(query: string, question: string, answer: string): number {
    if (!query) return 0;
    if (!question && !answer) return 0;

    let score = 0;

    if (question === query) {
      score += 0.85;
    } else {
      if (question.includes(query) || query.includes(question)) {
        score += 0.58;
      }
      if (question.startsWith(query) || query.startsWith(question)) {
        score += 0.12;
      }
    }

    const overlap = this.tokenOverlap(query, question);
    score += overlap * 0.55;

    const answerOverlap = this.tokenOverlap(query, answer);
    score += answerOverlap * 0.15;

    const fuzzy = fuzzyRatio(question, query);
    score += fuzzy * 0.35;

    const phonetic = phoneticSimilarity(question, query);
    score += phonetic * 0.18;

    const tokenRatio = this.wordCoverage(query, question);
    score += tokenRatio * 0.2;

    if (query.split(/\s+/).length > 1 && question.split(/\s+/).length > 1) {
      const sequenceBoost = this.sequenceBoost(query, question);
      score += sequenceBoost * 0.25;
    }

    const total = Math.min(1, Math.max(0, score));
    return Number(total.toFixed(4));
  }

  private tokenOverlap(left: string, right: string): number {
    const leftTokens = tokenize(left);
    const rightTokens = tokenize(right);
    if (!leftTokens.length || !rightTokens.length) return 0;

    const leftSet = new Set(leftTokens);
    const rightSet = new Set(rightTokens);
    const overlap = [...leftSet].filter(token => rightSet.has(token)).length;
    const union = new Set([...leftSet, ...rightSet]).size || 1;
    return overlap / union;
  }

  private wordCoverage(left: string, right: string): number {
    const leftTokens = tokenize(left);
    const rightTokens = tokenize(right);
    if (!leftTokens.length) return 0;
    if (!rightTokens.length) return 0;

    const matched = leftTokens.filter(token => rightTokens.includes(token)).length;
    return matched / leftTokens.length;
  }

  private sequenceBoost(left: string, right: string): number {
    const leftTokens = tokenize(left);
    const rightTokens = tokenize(right);
    if (!leftTokens.length || !rightTokens.length) return 0;

    const maxLen = Math.max(leftTokens.length, rightTokens.length);
    if (!maxLen) return 0;

    let shared = 0;
    for (let i = 0; i < Math.min(leftTokens.length, rightTokens.length); i++) {
      if (leftTokens[i] === rightTokens[i]) {
        shared += 1;
      }
    }

    return shared / maxLen;
  }
}

export const kbdRetrievalService = new KBDRetrievalService();
