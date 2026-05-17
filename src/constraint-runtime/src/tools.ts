import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { PortingModule } from './models.js';
import { executeToolFromSnapshot } from './dynamic-tool-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SNAPSHOT_PATH = path.join(__dirname, 'reference_data', 'tools_snapshot.json');

export interface ToolExecution {
  name: string;
  sourceHint: string;
  payload: string;
  handled: boolean;
  message: string;
}

function loadToolSnapshot(): PortingModule[] {
  const raw = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8'));
  return raw.map((e: any) => ({
    name: e.name,
    responsibility: e.responsibility,
    sourceHint: e.source_hint,
    status: 'mirrored' as const,
  }));
}

export const PORTED_TOOLS = loadToolSnapshot();

export { PortingModule };

export function getTool(name: string): PortingModule | undefined {
  const needle = name.toLowerCase();
  return PORTED_TOOLS.find(m => m.name.toLowerCase() === needle);
}

export function getTools(simpleMode: boolean = false): PortingModule[] {
  let tools = [...PORTED_TOOLS];
  if (simpleMode) {
    tools = tools.filter(m => ['BashTool', 'FileReadTool', 'FileEditTool'].includes(m.name));
  }
  return tools;
}

export function findTools(query: string, limit: number = 20): PortingModule[] {
  const needle = query.toLowerCase();
  return PORTED_TOOLS.filter(
    m => m.name.toLowerCase().includes(needle) || m.sourceHint.toLowerCase().includes(needle)
  ).slice(0, limit);
}

export async function executeTool(name: string, payload: string = ''): Promise<ToolExecution> {
  const module = getTool(name);
  if (!module) {
    return { name, sourceHint: '', payload, handled: false, message: `Unknown mirrored tool: ${name}` };
  }

  let params = {};
  try {
    params = payload ? JSON.parse(payload) : {};
  } catch {
    return {
      name: module.name,
      sourceHint: module.sourceHint,
      payload,
      handled: false,
      message: `Invalid JSON payload for tool '${module.name}'`,
    };
  }

  const result = await executeToolFromSnapshot(module.sourceHint, params);

  if (result.success) {
    return {
      name: module.name,
      sourceHint: module.sourceHint,
      payload: JSON.stringify(result.data),
      handled: true,
      message: `Tool '${module.name}' executed successfully`,
    };
  } else {
    return {
      name: module.name,
      sourceHint: module.sourceHint,
      payload,
      handled: false,
      message: `Tool '${module.name}' failed: ${result.error}`,
    };
  }
}