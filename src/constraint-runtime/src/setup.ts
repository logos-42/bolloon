import * as platform from 'platform';
import * as path from 'path';
import { runDeferredInit, DeferredInitResult } from './deferred_init.js';
import { startMdmRawRead, startKeychainPrefetch, startProjectScan, PrefetchResult } from './prefetch.js';

export interface WorkspaceSetup {
  pythonVersion: string;
  implementation: string;
  platformName: string;
  testCommand: string;
  startupSteps: string[];
}

export interface SetupReport {
  setup: WorkspaceSetup;
  prefetches: PrefetchResult[];
  deferredInit: DeferredInitResult;
  trusted: boolean;
  cwd: string;
}

export function buildWorkspaceSetup(): WorkspaceSetup {
  return {
    pythonVersion: `${platform.version}`,
    implementation: platform.name || 'unknown',
    platformName: platform.os?.toString() || 'unknown',
    testCommand: 'npm test',
    startupSteps: [
      'start top-level prefetch side effects',
      'build workspace context',
      'load mirrored command snapshot',
      'load mirrored tool snapshot',
      'prepare parity audit hooks',
      'apply trust-gated deferred init',
    ],
  };
}

export function runSetup(cwd?: string, trusted: boolean = true): SetupReport {
  const root = cwd || process.cwd();
  return {
    setup: buildWorkspaceSetup(),
    prefetches: [startMdmRawRead(), startKeychainPrefetch(), startProjectScan(root)],
    deferredInit: runDeferredInit(trusted),
    trusted,
    cwd: root,
  };
}

export { buildWorkspaceSetup as buildSetup };