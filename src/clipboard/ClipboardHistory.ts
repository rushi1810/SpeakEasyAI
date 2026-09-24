import { ClipboardItem } from './ClipboardTypes';
import { store } from '../store';

const MAX_ITEMS = 20;

export class ClipboardHistory {
  private items: ClipboardItem[] = [];

  constructor() {
    try {
      const persisted = store.get('clipboardHistory') as ClipboardItem[] | undefined;
      if (Array.isArray(persisted)) this.items = persisted.slice(-MAX_ITEMS);
    } catch (e) {
      this.items = [];
    }
  }

  add(item: ClipboardItem) {
    this.items = [...this.items.filter(i => i.text !== item.text), item];
    if (this.items.length > MAX_ITEMS) this.items = this.items.slice(-MAX_ITEMS);
    try { store.set('clipboardHistory', this.items); } catch (e) { /* ignore */ }
  }

  list(): ClipboardItem[] {
    return [...this.items].reverse();
  }

  clear(): void {
    this.items = [];
    try { store.set('clipboardHistory', []); } catch (e) { /* ignore */ }
  }
}

export const clipboardHistory = new ClipboardHistory();
