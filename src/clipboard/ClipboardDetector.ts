import { ClipboardItem } from './ClipboardTypes';

export class ClipboardDetector {
  static detectType(text: string): string {
    const t = text.trim();
    if (!t) return 'empty';

    // JSON
    if (/^\s*[{\[]/.test(t) && /\}\s*$|\]\s*$/.test(t)) return 'JSON';
    if (/^\s*[- ]*\w+:\s+/m.test(t)) return 'YAML';

    // SQL
    if (/\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bFROM\b/i.test(t)) return 'SQL Query';

    // Language heuristics
    if (/^\s*def\s+\w+\(|^\s*import\s+\w+/m.test(t)) return 'Python Code';
    if (/public\s+class\s+\w+|System\.out\.println|void\s+main\(/.test(t)) return 'Java Code';
    if (/console\.log\(|function\s+\w+\(|=>|const\s+\w+/m.test(t)) return 'JavaScript';
    if (/using\s+System;|Console\.WriteLine\(|namespace\s+\w+/.test(t)) return 'C#';

    if (/Stack trace|at\s+/.test(t)) return 'Stack Trace';
    if (/Exception:|Error:|\bTraceback\b/.test(t)) return 'Error Log';

    if (/leetcode|LeetCode|HackerRank/i.test(t)) return 'LeetCode Problem';

    if (/^\$\s*aws\s+/m.test(t)) return 'AWS CLI';
    if (/^az\s+/m.test(t)) return 'Azure CLI';
    if (/kubectl\s+/m.test(t) || /kind:\s+/m.test(t)) return 'Kubernetes YAML';
    if (/^[\w\-]+:\s+\/|curl\s+/m.test(t)) return 'Linux Command';

    // Heuristic for questions
    if (/\b(can you|could you|would you|explain|how|what|why|when|where|which|implement|write|debug)\b/i.test(t)) return 'Interview Question';

    // Default fallbacks
    if (t.split('\n').length > 6 && /\{/.test(t)) return 'Documentation';

    return 'General Question';
  }
}
