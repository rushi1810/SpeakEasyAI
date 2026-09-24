import { clipboard } from 'electron';
import { isProbablyUrl, isProbablyFilePath, isOtpOrPin, isLikelyPassword, isMostlyNumbers } from './ClipboardUtils';

export class ClipboardFilter {
  static shouldIgnoreText(text: string | undefined | null): boolean {
    if (!text) return true;
    const trimmed = String(text).trim();
    if (!trimmed) return true;
    if (trimmed.length < 10) return true; // ignore short strings
    if (isProbablyUrl(trimmed)) return true;
    if (isProbablyFilePath(trimmed)) return true;
    if (isOtpOrPin(trimmed)) return true;
    if (isLikelyPassword(trimmed)) return true;
    if (isMostlyNumbers(trimmed)) return true;
    return false;
  }

  static clipboardHasImage(): boolean {
    try {
      const img = clipboard.readImage();
      return !img.isEmpty();
    } catch (e) {
      return false;
    }
  }
}
