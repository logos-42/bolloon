import { getCommands, type CommandEntry } from './commands';
import { getTools, type ToolEntry, executeTool } from './tools';
import { executeCommand } from './commands';
import { ToolPermissionContext } from './permissions';
import { buildSystemInitMessage } from './system-init';

export interface RoutedMatch {
  kind: 'command' | 'tool';
  name: string;
  sourceHint: string;
  score: number;
}

export interface RuntimeSession {
  sessionId: string;
  prompt: string;
  trusted: boolean;
  systemInitMessage: string;
  routedMatches: RoutedMatch[];
  commandExecutionMessages: string[];
  toolExecutionMessages: string[];
  permissionDenials: { toolName: string; reason: string }[];
}

export interface TurnResult {
  output: string;
  matchedCommands: string[];
  matchedTools: string[];
  permissionDenials: { toolName: string; reason: string }[];
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number };
}

export class ConstraintRuntime {
  private permissionContext: ToolPermissionContext;

  constructor(permissionContext?: ToolPermissionContext) {
    this.permissionContext = permissionContext || new ToolPermissionContext();
  }

  routePrompt(prompt: string, limit = 5): RoutedMatch[] {
    const tokens = new Set(
      prompt
        .replace(/\//g, ' ')
        .replace(/-/g, ' ')
        .split(/\s+/)
        .map((t) => t.toLowerCase())
        .filter((t) => t.length > 0)
    );

    const commandMatches = this.scoreMatches(tokens, getCommands(), 'command');
    const toolMatches = this.scoreMatches(tokens, getTools(), 'tool');

    const selected: RoutedMatch[] = [];

    if (commandMatches.length > 0) {
      selected.push(commandMatches[0]);
    }
    if (toolMatches.length > 0) {
      selected.push(toolMatches[0]);
    }

    const leftovers = [...commandMatches, ...toolMatches]
      .filter((m) => !selected.some((s) => s.name === m.name))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

    selected.push(...leftovers.slice(0, Math.max(0, limit - selected.length)));

    return selected.slice(0, limit);
  }

  private scoreMatches(
    tokens: Set<string>,
    entries: readonly (CommandEntry | ToolEntry)[],
    kind: 'command' | 'tool'
  ): RoutedMatch[] {
    const matches: RoutedMatch[] = [];

    for (const entry of entries) {
      const haystacks = [entry.name.toLowerCase(), entry.sourceHint.toLowerCase()];
      let score = 0;
      for (const token of tokens) {
        if (haystacks.some((h) => h.includes(token))) {
          score += 1;
        }
      }
      if (score > 0) {
        matches.push({
          kind,
          name: entry.name,
          sourceHint: entry.sourceHint,
          score,
        });
      }
    }

    return matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  bootstrapSession(prompt: string, limit = 5, trusted = true): RuntimeSession {
    const sessionId = crypto.randomUUID();
    const matches = this.routePrompt(prompt, limit);

    const commandExecs: string[] = [];
    const toolExecs: string[] = [];
    const denials: { toolName: string; reason: string }[] = [];

    for (const match of matches) {
      if (match.kind === 'command') {
        const result = executeCommand(match.name, prompt);
        if (result.handled) {
          commandExecs.push(result.message);
        }
      } else if (match.kind === 'tool') {
        if (this.permissionContext.blocks(match.name)) {
          denials.push({
            toolName: match.name,
            reason: 'permission denied by context',
          });
        } else {
          const result = executeTool(match.name, '');
          if (result.handled) {
            toolExecs.push(result.message);
          }
        }
      }
    }

    return {
      sessionId,
      prompt,
      trusted,
      systemInitMessage: buildSystemInitMessage(trusted),
      routedMatches: matches,
      commandExecutionMessages: commandExecs,
      toolExecutionMessages: toolExecs,
      permissionDenials: denials,
    };
  }

  runTurnLoop(
    prompt: string,
    limit = 5,
    maxTurns = 3
  ): TurnResult[] {
    const results: TurnResult[] = [];
    let currentPrompt = prompt;

    for (let turn = 0; turn < maxTurns; turn++) {
      const turnPrompt = turn === 0 ? currentPrompt : `${currentPrompt} [turn ${turn + 1}]`;
      const matches = this.routePrompt(turnPrompt, limit);

      const commandNames = matches
        .filter((m) => m.kind === 'command')
        .map((m) => m.name);
      const toolNames = matches
        .filter((m) => m.kind === 'tool')
        .map((m) => m.name);

      const outputLines = [
        `Turn ${turn + 1}`,
        `Prompt: ${turnPrompt}`,
        `Matched commands: ${commandNames.join(', ') || 'none'}`,
        `Matched tools: ${toolNames.join(', ') || 'none'}`,
      ];

      const output = outputLines.join('\n');
      const inputTokens = turnPrompt.split(/\s+/).length;
      const outputTokens = output.split(/\s+/).length;

      results.push({
        output,
        matchedCommands: commandNames,
        matchedTools: toolNames,
        permissionDenials: [],
        stopReason: 'completed',
        usage: { inputTokens, outputTokens },
      });

      if (turn < maxTurns - 1) {
        currentPrompt = turnPrompt;
      }
    }

    return results;
  }

  setPermissionContext(context: ToolPermissionContext): void {
    this.permissionContext = context;
  }

  getPermissionContext(): ToolPermissionContext {
    return this.permissionContext;
  }
}

export const defaultRuntime = new ConstraintRuntime();
