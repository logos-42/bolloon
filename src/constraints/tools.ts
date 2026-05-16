import { ToolPermissionContext } from './permissions';

export interface ToolEntry {
  name: string;
  responsibility: string;
  sourceHint: string;
  status: 'planned' | 'mirrored' | 'implemented';
}

export interface ToolExecution {
  name: string;
  sourceHint: string;
  payload: string;
  handled: boolean;
  message: string;
}

const PORTED_TOOLS_DATA: ToolEntry[] = [
  {
    name: 'read_document',
    responsibility: 'Read content from a document or file',
    sourceHint: 'bolloon/documents/reader.ts',
    status: 'mirrored',
  },
  {
    name: 'summarize_document',
    responsibility: 'Generate a summary of a document',
    sourceHint: 'bolloon/documents/summarizer.ts',
    status: 'mirrored',
  },
  {
    name: 'improve_document',
    responsibility: 'Improve the quality of a document',
    sourceHint: 'bolloon/documents/improver.ts',
    status: 'mirrored',
  },
  {
    name: 'list_peers',
    responsibility: 'List all connected peers in the network',
    sourceHint: 'bolloon/network/p2p.ts',
    status: 'mirrored',
  },
  {
    name: 'send_message',
    responsibility: 'Send a direct message to a peer',
    sourceHint: 'bolloon/network/messaging.ts',
    status: 'mirrored',
  },
  {
    name: 'broadcast_message',
    responsibility: 'Broadcast a message to all connected peers',
    sourceHint: 'bolloon/network/messaging.ts',
    status: 'mirrored',
  },
  {
    name: 'get_identity',
    responsibility: 'Get the identity information of the current node',
    sourceHint: 'bolloon/agents/protocol.ts',
    status: 'mirrored',
  },
  {
    name: 'get_operation_logs',
    responsibility: 'Retrieve operation logs for the current session',
    sourceHint: 'bolloon/agents/protocol.ts',
    status: 'mirrored',
  },
  {
    name: 'search_files',
    responsibility: 'Search for files matching a query pattern',
    sourceHint: 'bolloon/documents/search.ts',
    status: 'mirrored',
  },
];

export const PORTED_TOOLS: readonly ToolEntry[] = PORTED_TOOLS_DATA;

export function getTool(name: string): ToolEntry | null {
  const needle = name.toLowerCase();
  for (const tool of PORTED_TOOLS) {
    if (tool.name.toLowerCase() === needle) {
      return tool;
    }
  }
  return null;
}

export function getTools(): ToolEntry[] {
  return [...PORTED_TOOLS];
}

export function findTools(query: string, limit = 20): ToolEntry[] {
  const needle = query.toLowerCase();
  const matches = PORTED_TOOLS.filter(
    (tool) =>
      tool.name.toLowerCase().includes(needle) ||
      tool.sourceHint.toLowerCase().includes(needle)
  );
  return matches.slice(0, limit);
}

export function executeTool(name: string, payload = ''): ToolExecution {
  const tool = getTool(name);
  if (tool === null) {
    return {
      name,
      sourceHint: '',
      payload,
      handled: false,
      message: `Unknown mirrored tool: ${name}`,
    };
  }
  const message = `Mirrored tool '${tool.name}' from ${tool.sourceHint} would handle payload ${JSON.stringify(payload)}.`;
  return {
    name: tool.name,
    sourceHint: tool.sourceHint,
    payload,
    handled: true,
    message,
  };
}

export function filterToolsByPermissionContext(
  tools: readonly ToolEntry[],
  permissionContext: ToolPermissionContext | null
): ToolEntry[] {
  if (permissionContext === null) {
    return [...tools];
  }
  return tools.filter((tool) => !permissionContext.blocks(tool.name));
}

export function toolNames(): string[] {
  return PORTED_TOOLS.map((tool) => tool.name);
}