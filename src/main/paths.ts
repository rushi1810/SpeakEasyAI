import * as path from 'path';
import * as nativeFs from 'fs';

const systemDrive = process.env.SystemDrive || 'C:';

export const APP_ROOT = path.resolve(systemDrive, 'SpeakEasy AI');
export const KBD_DIR = path.join(APP_ROOT, 'KBD');
export const JD_DIR = path.join(APP_ROOT, 'JD');
export const RESUME_DIR = path.join(APP_ROOT, 'Resume');
export const SESSIONS_DIR = path.join(APP_ROOT, 'Sessions');
export const LOGS_DIR = path.join(APP_ROOT, 'Logs');

export const REQUIRED_DIRECTORIES = [
  APP_ROOT,
  KBD_DIR,
  JD_DIR,
  RESUME_DIR,
  SESSIONS_DIR,
  LOGS_DIR
];

export function ensureAppRootExistsSync(): void {
  nativeFs.mkdirSync(APP_ROOT, { recursive: true });
}

export function isPathWithinAppRoot(candidatePath: string): boolean {
  try {
    const resolvedCandidate = path.resolve(candidatePath);
    const resolvedRoot = path.resolve(APP_ROOT);
    return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
  } catch {
    return false;
  }
}
