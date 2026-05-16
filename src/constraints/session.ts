import * as fs from 'fs/promises';
import * as path from 'path';

export interface StoredSession {
  sessionId: string;
  messages: string[];
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
  updatedAt: string;
}

export interface SessionEntry {
  id: string;
  type: 'user' | 'ai' | 'system';
  content: string;
  timestamp: string;
}

const DEFAULT_SESSION_DIR = path.join(process.env.HOME || '/tmp', '.bolloon', 'sessions');

export async function saveSession(session: StoredSession, directory?: string): Promise<string> {
  const targetDir = directory || DEFAULT_SESSION_DIR;
  await fs.mkdir(targetDir, { recursive: true });
  const filePath = path.join(targetDir, `${session.sessionId}.json`);
  await fs.writeFile(filePath, JSON.stringify(session, null, 2));
  return filePath;
}

export async function loadSession(sessionId: string, directory?: string): Promise<StoredSession> {
  const targetDir = directory || DEFAULT_SESSION_DIR;
  const data = await fs.readFile(path.join(targetDir, `${sessionId}.json`), 'utf-8');
  return JSON.parse(data) as StoredSession;
}

export async function listSessions(directory?: string): Promise<StoredSession[]> {
  const targetDir = directory || DEFAULT_SESSION_DIR;
  try {
    const files = await fs.readdir(targetDir);
    const sessions: StoredSession[] = [];
    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const data = await fs.readFile(path.join(targetDir, file), 'utf-8');
          sessions.push(JSON.parse(data) as StoredSession);
        } catch {
          // Skip invalid session files
        }
      }
    }
    return sessions.sort((a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  } catch {
    return [];
  }
}

export async function deleteSession(sessionId: string, directory?: string): Promise<boolean> {
  const targetDir = directory || DEFAULT_SESSION_DIR;
  const filePath = path.join(targetDir, `${sessionId}.json`);
  try {
    await fs.unlink(filePath);
    return true;
  } catch {
    return false;
  }
}