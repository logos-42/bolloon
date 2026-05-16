export interface DenialReason {
  toolName: string;
  reason: string;
}

export class ToolPermissionContext {
  readonly denyNames: Set<string>;
  readonly denyPrefixes: readonly string[];

  constructor(
    denyNames: Set<string> = new Set(),
    denyPrefixes: readonly string[] = []
  ) {
    this.denyNames = denyNames;
    this.denyPrefixes = denyPrefixes;
  }

  static fromIterables(
    denyNames?: Iterable<string> | null,
    denyPrefixes?: Iterable<string> | null
  ): ToolPermissionContext {
    return new ToolPermissionContext(
      new Set(
        denyNames
          ? Array.from(denyNames).map((n) => n.toLowerCase())
          : []
      ),
      denyPrefixes
        ? Array.from(denyPrefixes).map((p) => p.toLowerCase())
        : []
    );
  }

  blocks(toolName: string): boolean {
    const lowered = toolName.toLowerCase();
    return (
      this.denyNames.has(lowered) ||
      this.denyPrefixes.some((prefix) => lowered.startsWith(prefix))
    );
  }

  withDenial(name: string, reason: string): {
    context: ToolPermissionContext;
    denial: DenialReason;
  } {
    const newDenyNames = new Set(this.denyNames);
    newDenyNames.add(name.toLowerCase());
    return {
      context: new ToolPermissionContext(newDenyNames, this.denyPrefixes),
      denial: { toolName: name, reason },
    };
  }
}

export interface PermissionCheckResult {
  allowed: boolean;
  denialReason?: DenialReason;
}

export function checkPermission(
  context: ToolPermissionContext,
  toolName: string,
  reason: string
): PermissionCheckResult {
  if (context.blocks(toolName)) {
    return {
      allowed: false,
      denialReason: { toolName, reason },
    };
  }
  return { allowed: true };
}