export type ClipboardSource = 'keyboard' | 'system' | 'app';

export interface ClipboardItem {
  id: string;
  text: string;
  type: string; // classification type
  timestamp: number;
  source: ClipboardSource;
}
