import { PermissionDenial } from '../models.js';

export class ToolPermissionContext {
  private denyTools: Set<string>;
  private denyPrefixes: string[];

  private constructor(denyTools: Set<string>, denyPrefixes: string[]) {
    this.denyTools = denyTools;
    this.denyPrefixes = denyPrefixes;
  }

  static fromIterables(denyTools: string[] = [], denyPrefixes: string[] = []): ToolPermissionContext {
    return new ToolPermissionContext(
      new Set(denyTools.map(t => t.toLowerCase())),
      denyPrefixes
    );
  }

  blocks(name: string): boolean {
    const lower = name.toLowerCase();
    if (this.denyTools.has(lower)) return true;
    return this.denyPrefixes.some(p => lower.startsWith(p.toLowerCase()));
  }

  createDenial(toolName: string, reason: string): PermissionDenial {
    return { toolName, reason };
  }
}
