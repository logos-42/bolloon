export type CommandStatus = 'planned' | 'mirrored' | 'implemented';

export interface CommandEntry {
  name: string;
  responsibility: string;
  sourceHint: string;
  status: CommandStatus;
}

export interface CommandExecution {
  name: string;
  sourceHint: string;
  prompt: string;
  handled: boolean;
  message: string;
}

export const PORTED_COMMANDS: CommandEntry[] = [
  {
    name: 'read',
    responsibility: 'Read and display file contents',
    sourceHint: 'bolloon built-in',
    status: 'mirrored',
  },
  {
    name: 'summarize',
    responsibility: 'Summarize conversation or context',
    sourceHint: 'bolloon built-in',
    status: 'mirrored',
  },
  {
    name: 'improve',
    responsibility: 'Improve code or text quality',
    sourceHint: 'bolloon built-in',
    status: 'mirrored',
  },
  {
    name: 'broadcast',
    responsibility: 'Broadcast message to multiple targets',
    sourceHint: 'bolloon built-in',
    status: 'mirrored',
  },
  {
    name: 'send',
    responsibility: 'Send message to a specific target',
    sourceHint: 'bolloon built-in',
    status: 'mirrored',
  },
  {
    name: 'peers',
    responsibility: 'List connected peers',
    sourceHint: 'bolloon built-in',
    status: 'mirrored',
  },
  {
    name: 'identity',
    responsibility: 'Display current identity information',
    sourceHint: 'bolloon built-in',
    status: 'mirrored',
  },
  {
    name: 'logs',
    responsibility: 'Retrieve and display logs',
    sourceHint: 'bolloon built-in',
    status: 'mirrored',
  },
  {
    name: 'tools',
    responsibility: 'List available tools',
    sourceHint: 'bolloon built-in',
    status: 'mirrored',
  },
  {
    name: 'search',
    responsibility: 'Search across files or content',
    sourceHint: 'bolloon built-in',
    status: 'mirrored',
  },
];

export function getCommand(name: string): CommandEntry | null {
  const needle = name.toLowerCase();
  for (const entry of PORTED_COMMANDS) {
    if (entry.name.toLowerCase() === needle) {
      return entry;
    }
  }
  return null;
}

export function getCommands(): CommandEntry[] {
  return [...PORTED_COMMANDS];
}

export function findCommands(query: string, limit = 20): CommandEntry[] {
  const needle = query.toLowerCase();
  const matches = PORTED_COMMANDS.filter(
    (entry) =>
      entry.name.toLowerCase().includes(needle) ||
      entry.sourceHint.toLowerCase().includes(needle),
  );
  return matches.slice(0, limit);
}

export function executeCommand(name: string, prompt = ''): CommandExecution {
  const entry = getCommand(name);
  if (entry === null) {
    return {
      name,
      sourceHint: '',
      prompt,
      handled: false,
      message: `Unknown mirrored command: ${name}`,
    };
  }
  const action = `Mirrored command '${entry.name}' from ${entry.sourceHint} would handle prompt ${JSON.stringify(prompt)}.`;
  return {
    name: entry.name,
    sourceHint: entry.sourceHint,
    prompt,
    handled: true,
    message: action,
  };
}