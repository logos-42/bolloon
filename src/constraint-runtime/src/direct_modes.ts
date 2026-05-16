export interface DirectModeReport {
  mode: string;
  target: string;
  active: boolean;
}

export function runDirectConnect(target: string): DirectModeReport {
  return { mode: 'direct-connect', target, active: true };
}

export function runDeepLink(target: string): DirectModeReport {
  return { mode: 'deep-link', target, active: true };
}
