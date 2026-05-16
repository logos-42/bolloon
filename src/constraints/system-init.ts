import type { ToolPermissionContext } from './permissions';
import { getCommands } from './commands';
import { getTools } from './tools';

export interface AgentContext {
  permissionContext?: ToolPermissionContext;
  cwd?: string;
}

export interface StartupStep {
  name: string;
  description: string;
}

export interface SystemInitReport {
  trusted: boolean;
  builtInCommandCount: number;
  loadedCommandCount: number;
  loadedToolCount: number;
  startupSteps: StartupStep[];
  permissionContext?: ToolPermissionContext;
  currentTime: string;
}

const STARTUP_STEPS: StartupStep[] = [
  { name: 'start top-level prefetch side effects', description: 'Initiate background prefetch operations' },
  { name: 'build workspace context', description: 'Construct workspace context for agent operations' },
  { name: 'load mirrored command snapshot', description: 'Load command definitions from snapshot' },
  { name: 'load mirrored tool snapshot', description: 'Load tool definitions from snapshot' },
  { name: 'prepare parity audit hooks', description: 'Set up parity audit instrumentation' },
  { name: 'apply trust-gated deferred init', description: 'Execute deferred initialization based on trust level' },
];

function buildWorkspaceSetup(trusted: boolean, context?: AgentContext): SystemInitReport {
  return {
    trusted,
    builtInCommandCount: getBuiltInCommandNames().size,
    loadedCommandCount: getCommands().length,
    loadedToolCount: getTools().length,
    startupSteps: STARTUP_STEPS,
    permissionContext: context?.permissionContext,
    currentTime: new Date().toISOString(),
  };
}

function getBuiltInCommandNames(): ReadonlySet<string> {
  const commands = getCommands();
  return new Set(commands.map((c) => c.name));
}

export function buildSystemInitMessage(trusted: boolean, context?: AgentContext): string {
  const setup = buildWorkspaceSetup(trusted, context);
  const commands = getCommands();
  const tools = getTools();

  const lines: string[] = [
    '# System Init',
    '',
    `Trusted: ${setup.trusted}`,
    `Built-in command names: ${setup.builtInCommandCount}`,
    `Loaded command entries: ${commands.length}`,
    `Loaded tool entries: ${tools.length}`,
    '',
    '## Available Commands',
    ...commands.map((cmd) => `- ${cmd.name}: ${cmd.responsibility}`),
    '',
    '## Available Tools',
    ...tools.map((tool) => `- ${tool.name}: ${tool.responsibility}`),
    '',
    '## Startup Steps',
    ...setup.startupSteps.map((step) => `- ${step.name}`),
    '',
    `Current Time: ${setup.currentTime}`,
  ];

  return lines.join('\n');
}

export { STARTUP_STEPS };