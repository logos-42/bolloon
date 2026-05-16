import * as path from 'path';

export interface PrefetchResult {
  name: string;
  started: boolean;
  detail: string;
}

export function startMdmRawRead(): PrefetchResult {
  return { name: 'mdm_raw_read', started: true, detail: 'Simulated MDM raw-read prefetch for workspace bootstrap' };
}

export function startKeychainPrefetch(): PrefetchResult {
  return { name: 'keychain_prefetch', started: true, detail: 'Simulated keychain prefetch for trusted startup path' };
}

export function startProjectScan(root: path.PathLike): PrefetchResult {
  return { name: 'project_scan', started: true, detail: `Scanned project root ${root}` };
}
