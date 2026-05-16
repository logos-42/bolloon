import { PORTED_COMMANDS, executeCommand } from './commands.js';
import { PORTED_TOOLS, executeTool } from './tools.js';

export class MirroredCommand {
  constructor(public name: string, public sourceHint: string) {}
  execute(prompt: string): string {
    return executeCommand(this.name, prompt).message;
  }
}

export class MirroredTool {
  constructor(public name: string, public sourceHint: string) {}
  execute(payload: string): string {
    return executeTool(this.name, payload).message;
  }
}

export class ExecutionRegistry {
  constructor(
    public commands: MirroredCommand[],
    public tools: MirroredTool[]
  ) {}

  command(name: string): MirroredCommand | undefined {
    const lowered = name.toLowerCase();
    return this.commands.find(c => c.name.toLowerCase() === lowered);
  }

  tool(name: string): MirroredTool | undefined {
    const lowered = name.toLowerCase();
    return this.tools.find(t => t.name.toLowerCase() === lowered);
  }
}

export function buildExecutionRegistry(): ExecutionRegistry {
  return new ExecutionRegistry(
    PORTED_COMMANDS.map(m => new MirroredCommand(m.name, m.sourceHint)),
    PORTED_TOOLS.map(m => new MirroredTool(m.name, m.sourceHint))
  );
}
