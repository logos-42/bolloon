import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { PortingModule } from './models.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SNAPSHOT_PATH = path.join(__dirname, 'reference_data', 'commands_snapshot.json');

export interface CommandExecution {
  name: string;
  sourceHint: string;
  prompt: string;
  handled: boolean;
  message: string;
}

function loadCommandSnapshot(): PortingModule[] {
  try {
    if (!fs.existsSync(SNAPSHOT_PATH)) {
      console.warn(`[commands] Snapshot not found: ${SNAPSHOT_PATH}, using empty list`);
      return [];
    }
    const raw = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8'));
    return raw.map((e: any) => ({
      name: e.name,
      responsibility: e.responsibility,
      sourceHint: e.source_hint,
      status: 'mirrored' as const,
    }));
  } catch (error) {
    console.warn(`[commands] Failed to load snapshot: ${error}, using empty list`);
    return [];
  }
}

export const PORTED_COMMANDS = loadCommandSnapshot();

export { PortingModule };

export function builtInCommandNames(): Set<string> {
  return new Set(PORTED_COMMANDS.map(m => m.name));
}

export function getCommand(name: string): PortingModule | undefined {
  const needle = name.toLowerCase();
  return PORTED_COMMANDS.find(m => m.name.toLowerCase() === needle);
}

export function getCommands(
  includePluginCommands: boolean = true,
  includeSkillCommands: boolean = true
): PortingModule[] {
  let commands = [...PORTED_COMMANDS];
  if (!includePluginCommands) {
    commands = commands.filter(m => !m.sourceHint.toLowerCase().includes('plugin'));
  }
  if (!includeSkillCommands) {
    commands = commands.filter(m => !m.sourceHint.toLowerCase().includes('skills'));
  }
  return commands;
}

export function findCommands(query: string, limit: number = 20): PortingModule[] {
  const needle = query.toLowerCase();
  return PORTED_COMMANDS.filter(
    m => m.name.toLowerCase().includes(needle) || m.sourceHint.toLowerCase().includes(needle)
  ).slice(0, limit);
}

export function executeCommand(name: string, prompt: string = ''): CommandExecution {
  const module = getCommand(name);
  if (!module) {
    return { name, sourceHint: '', prompt, handled: false, message: `Unknown mirrored command: ${name}` };
  }
  return {
    name: module.name,
    sourceHint: module.sourceHint,
    prompt,
    handled: true,
    message: `Mirrored command '${module.name}' from ${module.sourceHint} would handle prompt.`,
  };
}