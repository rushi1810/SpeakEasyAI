export interface ClipboardSettings {
  enabled: boolean;
  autoAnswer: boolean;
  historyEnabled: boolean;
  autoCopyAnswer: boolean;
  cooldownSeconds: number;
  maxSize: number; // max characters
  detectionSensitivity: 'low' | 'medium' | 'high';
}

export const DEFAULT_CLIPBOARD_SETTINGS: ClipboardSettings = {
  enabled: true,
  autoAnswer: true,
  historyEnabled: true,
  autoCopyAnswer: false,
  cooldownSeconds: 2,
  maxSize: 10000,
  detectionSensitivity: 'medium'
};
