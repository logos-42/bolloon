export interface PortingModule {
  name: string;
  responsibility: string;
  sourceHint: string;
  status: PortingStatus;
  readonly _jsonName?: string;
}

export interface Subsystem {
  name: string;
  path: string;
  fileCount: number;
  notes: string;
}

export interface PermissionDenial {
  toolName: string;
  reason: string;
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
}

export interface TurnResult {
  prompt: string;
  output: string;
  matchedCommands: string[];
  matchedTools: string[];
  permissionDenials: PermissionDenial[];
  usage: UsageSummary;
  stopReason: string;
}

export interface RoutedMatch {
  kind: 'command' | 'tool';
  name: string;
  sourceHint: string;
  score: number;
}

export type PortingStatus = 'mirrored' | 'ported' | 'pending';

export interface PortingBacklog {
  title: string;
  modules: PortingModule[];
  summaryLines(): string[];
}
