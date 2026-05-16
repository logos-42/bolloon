import { getCommands, builtInCommandNames } from './commands.js';
import { getTools } from './tools.js';
import { runSetup } from './setup.js';

export function buildSystemInitMessage(trusted: boolean = true): string {
  const setup = runSetup(trusted);
  const commands = getCommands();
  const tools = getTools();
  const lines = [
    '# System Init',
    '',
    `Trusted: ${setup.trusted}`,
    `Built-in command names: ${builtInCommandNames().size}`,
    `Loaded command entries: ${commands.length}`,
    `Loaded tool entries: ${tools.length}`,
    '',
    'Startup steps:',
    ...setup.setup.startupSteps.map(step => `- ${step}`),
  ];
  return lines.join('\n');
}
