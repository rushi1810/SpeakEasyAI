import { v4 as uuidv4 } from 'uuid';
import { ClipboardItem } from './ClipboardTypes';

export function makeClipboardItem(text: string, type: string, source: any = 'system'): ClipboardItem {
  return {
    id: uuidv4(),
    text,
    type,
    timestamp: Date.now(),
    source
  };
}

export function isProbablyUrl(text: string): boolean {
  return /^(https?:)?\/\/[\w\-]+(\.[\w\-]+)+[:0-9]*\/?/.test(text) || /\w+\.\w{2,}\/\S*/. test(text);
}

export function isProbablyFilePath(text: string): boolean {
  return /^[a-zA-Z]:(\\|\/).+|^\/.+\/[\w\-. ]+\.[a-zA-Z0-9]{1,6}$|^~\/.+/.test(text);
}

export function isOtpOrPin(text: string): boolean {
  const t = text.trim();
  return /^\d{4,8}$/.test(t);
}

export function isLikelyPassword(text: string): boolean {
  // heuristics: short but complex mix, or common words like 'password'
  const t = text.trim();
  if (/password|pwd|passw/i.test(t)) return true;
  if (t.length >= 8 && /[A-Z]/.test(t) && /[0-9]/.test(t) && /[^\w\s]/.test(t)) return true;
  return false;
}

export function isMostlyNumbers(text: string): boolean {
  const t = text.replace(/\s+/g, '');
  if (!t) return false;
  return /^[0-9]{6,}$/.test(t);
}
