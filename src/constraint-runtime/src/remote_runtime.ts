export interface RuntimeModeReport {
  mode: string;
  connected: boolean;
  detail: string;
}

export function runRemoteMode(target: string): RuntimeModeReport {
  return { mode: 'remote', connected: true, detail: `Remote control placeholder prepared for ${target}` };
}

export function runSshMode(target: string): RuntimeModeReport {
  return { mode: 'ssh', connected: true, detail: `SSH proxy placeholder prepared for ${target}` };
}

export function runTeleportMode(target: string): RuntimeModeReport {
  return { mode: 'teleport', connected: true, detail: `Teleport resume/create placeholder prepared for ${target}` };
}
