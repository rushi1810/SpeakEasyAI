import * as fs from 'fs-extra';
import * as path from 'path';

import {
  APP_ROOT,
  JD_DIR,
  KBD_DIR,
  LOGS_DIR,
  RESUME_DIR,
  SESSIONS_DIR,
  REQUIRED_DIRECTORIES,
  isPathWithinAppRoot
} from './paths';

const pathSeparatorPattern = /[\\/]/;

function sanitizeFileName(fileName: string, label: string): string {
  const normalized = String(fileName || '').trim();
  if (!normalized || normalized === '.' || normalized === '..') {
    throw new Error(`${label} name is required.`);
  }

  if (normalized.includes('..') || normalized.includes('/') || normalized.includes('\\')) {
    throw new Error(`${label} contains an invalid path.`);
  }

  if (/[<>:"|?*\x00-\x1F]/.test(normalized)) {
    throw new Error(`${label} contains unsupported characters.`);
  }

  return normalized;
}

function sanitizeSessionId(sessionId: string): string {
  const normalized = String(sessionId || '').trim();
  if (!normalized) {
    throw new Error('Session ID is required.');
  }

  const safeValue = normalized.replace(/[^a-zA-Z0-9_.-]+/g, '_');
  if (!safeValue || safeValue === '.' || safeValue === '..') {
    throw new Error('Session ID is invalid.');
  }

  return safeValue;
}

export function getAppRootDirectory(): string {
  return APP_ROOT;
}

export function getKbdDirectory(): string {
  return KBD_DIR;
}

export function getJdDirectory(): string {
  return JD_DIR;
}

export function getResumeDirectory(): string {
  return RESUME_DIR;
}

export function getSessionsDirectory(): string {
  return SESSIONS_DIR;
}

export function getLogsDirectory(): string {
  return LOGS_DIR;
}

export function resolveWithinRoot(baseDirectory: string, fileName: string): string {
  const safeName = sanitizeFileName(fileName, 'File');
  const targetPath = path.resolve(baseDirectory, safeName);

  if (!isPathWithinAppRoot(targetPath)) {
    throw new Error(`Refusing to access a path outside the SpeakEasy AI data directory: ${fileName}`);
  }

  return targetPath;
}

export async function initializeApplicationFolders(): Promise<void> {
  for (const directory of REQUIRED_DIRECTORIES) {
    await fs.ensureDir(directory);
  }

  for (const directory of REQUIRED_DIRECTORIES) {
    const stats = await fs.stat(directory).catch(() => null);
    if (!stats || !stats.isDirectory()) {
      throw new Error(`Required directory is missing or invalid: ${directory}`);
    }

    await fs.access(directory, fs.constants.R_OK | fs.constants.W_OK).catch(() => {
      throw new Error(`Application does not have write access to: ${directory}`);
    });
  }

  await migrateLegacyDirectories();
}

export async function migrateLegacyDirectories(): Promise<void> {
  const legacyDirectories = [
    { source: path.join(process.cwd(), 'KBD'), target: KBD_DIR },
    { source: path.join(process.cwd(), 'JD'), target: JD_DIR },
    { source: path.join(process.cwd(), 'resume'), target: RESUME_DIR },
    { source: path.join(process.cwd(), 'Sessions'), target: SESSIONS_DIR },
    { source: path.join('D:\\', 'SpeakEasyAI', 'Sessions'), target: SESSIONS_DIR },
    { source: path.join(process.cwd(), 'Logs'), target: LOGS_DIR },
    { source: path.join(process.cwd(), 'content', 'KBD'), target: KBD_DIR },
    { source: path.join(process.cwd(), 'content', 'JD'), target: JD_DIR },
    { source: path.join(process.cwd(), 'content', 'resume'), target: RESUME_DIR }
  ];

  for (const legacyEntry of legacyDirectories) {
    const sourcePath = path.resolve(legacyEntry.source);
    const targetPath = path.resolve(legacyEntry.target);

    if (!sourcePath || !targetPath || sourcePath === targetPath) {
      continue;
    }

    const sourceExists = await fs.pathExists(sourcePath);
    if (!sourceExists) {
      continue;
    }

    const targetExists = await fs.pathExists(targetPath);
    if (!targetExists) {
      await fs.copy(sourcePath, targetPath, { overwrite: false, errorOnExist: false });
      continue;
    }

    const sourceFiles = await fs.readdir(sourcePath).catch(() => []);
    for (const entry of sourceFiles) {
      const sourceItem = path.join(sourcePath, entry);
      const targetItem = path.join(targetPath, entry);
      const alreadyExists = await fs.pathExists(targetItem);
      if (!alreadyExists) {
        await fs.copy(sourceItem, targetItem, { overwrite: false, errorOnExist: false });
      }
    }
  }
}

export async function listFilesInDirectory(directory: string): Promise<string[]> {
  await fs.ensureDir(directory);
  const items = await fs.readdir(directory, { withFileTypes: true });
  return items
    .filter(item => item.isFile())
    .map(item => item.name)
    .sort((a, b) => a.localeCompare(b));
}

export async function saveFileToDirectory(directory: string, fileName: string, content: string | Buffer): Promise<string> {
  await fs.ensureDir(directory);
  const targetPath = resolveWithinRoot(directory, fileName);
  await fs.writeFile(targetPath, content);
  return targetPath;
}

export async function deleteFileFromDirectory(directory: string, fileName: string): Promise<boolean> {
  const targetPath = resolveWithinRoot(directory, fileName);
  if (!await fs.pathExists(targetPath)) {
    return false;
  }

  await fs.remove(targetPath);
  return true;
}

export async function saveKbdFile(fileName: string, content: string | Buffer): Promise<string> {
  return saveFileToDirectory(KBD_DIR, fileName, content);
}

export async function listKbdFiles(): Promise<string[]> {
  return listFilesInDirectory(KBD_DIR);
}

export async function deleteKbdFile(fileName: string): Promise<boolean> {
  return deleteFileFromDirectory(KBD_DIR, fileName);
}

export async function saveJdFile(fileName: string, content: string | Buffer): Promise<string> {
  return saveFileToDirectory(JD_DIR, fileName, content);
}

export async function listJdFiles(): Promise<string[]> {
  return listFilesInDirectory(JD_DIR);
}

export async function deleteJdFile(fileName: string): Promise<boolean> {
  return deleteFileFromDirectory(JD_DIR, fileName);
}

export async function saveResumeFile(fileName: string, content: string | Buffer): Promise<string> {
  return saveFileToDirectory(RESUME_DIR, fileName, content);
}

export async function listResumeFiles(): Promise<string[]> {
  return listFilesInDirectory(RESUME_DIR);
}

export async function deleteResumeFile(fileName: string): Promise<boolean> {
  return deleteFileFromDirectory(RESUME_DIR, fileName);
}

export async function getSessionDirectory(sessionId: string): Promise<string> {
  const safeSessionId = sanitizeSessionId(sessionId);
  const directory = path.join(SESSIONS_DIR, safeSessionId);
  await fs.ensureDir(directory);
  return directory;
}

export async function listSessions(): Promise<string[]> {
  await fs.ensureDir(SESSIONS_DIR);
  const entries = await fs.readdir(SESSIONS_DIR, { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

export async function saveSessionRecord(session: { id: string }): Promise<string> {
  const sessionId = sanitizeSessionId(session.id);
  const sessionDir = path.join(SESSIONS_DIR, sessionId);
  const sessionFile = path.join(sessionDir, 'session.json');
  await fs.ensureDir(sessionDir);
  await fs.writeJson(sessionFile, session, { spaces: 2, EOL: '\r\n' });
  return sessionFile;
}

export async function deleteSessionRecord(sessionId: string): Promise<boolean> {
  const safeId = sanitizeSessionId(sessionId);
  const directory = path.join(SESSIONS_DIR, safeId);
  if (!await fs.pathExists(directory)) {
    return false;
  }

  await fs.remove(directory);
  return true;
}

export function isSafeAppPath(candidatePath: string): boolean {
  return isPathWithinAppRoot(candidatePath);
}

export function getSafelyJoinedPath(baseDirectory: string, relativePath: string): string {
  const normalizedRelative = String(relativePath || '').trim();
  if (!normalizedRelative) {
    throw new Error('Relative path is required.');
  }

  if (normalizedRelative.includes('..') || pathSeparatorPattern.test(normalizedRelative)) {
    throw new Error('Relative path traversal is not allowed.');
  }

  const targetPath = path.resolve(baseDirectory, normalizedRelative);
  if (!isPathWithinAppRoot(targetPath)) {
    throw new Error('Target path is outside the allowed SpeakEasy AI data directory.');
  }

  return targetPath;
}
