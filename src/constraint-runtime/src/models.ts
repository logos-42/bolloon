export type PortingStatus = 'mirrored' | 'ported' | 'pending';

export interface PortingModule {
  name: string;
  responsibility: string;
  source_hint: string;
  status: PortingStatus;
}

export interface PermissionDenial {
  tool_name: string;
  reason: string;
}

export interface UsageSummary {
  input_tokens: number;
  output_tokens: number;
}

export interface TurnResult {
  prompt: string;
  output: string;
  matched_commands: string[];
  matched_tools: string[];
  permission_denials: PermissionDenial[];
  usage: UsageSummary;
  stop_reason: string;
}

export interface RoutedMatch {
  kind: 'command' | 'tool';
  name: string;
  source_hint: string;
  score: number;
}
