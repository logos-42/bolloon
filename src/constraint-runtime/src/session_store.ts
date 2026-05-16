import * as fs from 'fs';
import * as path from 'path';

export interface StoredSession {
  sessionId: string;
  messages: string[];
  inputTokens: number;
  outputTokens: number;
}

const SESSION_DIR = '.port_sessions';

export function saveSession(session: StoredSession): string {
  const targetDir = path.join(process.cwd(), SESSION_DIR);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  const filePath = path.join(targetDir, `${session.sessionId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2));
  return filePath;
}

export function loadSession(sessionId: string): StoredSession {
  const filePath = path.join(process.cwd(), SESSION_DIR, `${sessionId}.json`);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return {
    sessionId: data.sessionId,
    messages: data.messages,
    inputTokens: data.inputTokens,
    outputTokens: data.outputTokens,
  };
}