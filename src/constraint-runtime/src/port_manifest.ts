import * as path from 'path';
import { Subsystem } from './models.js';

export interface PortManifest {
  srcRoot: string;
  totalPythonFiles: number;
  topLevelModules: Subsystem[];
}

export function buildPortManifest(srcRoot?: string): PortManifest {
  return {
    srcRoot: srcRoot || __dirname,
    totalPythonFiles: 0,
    topLevelModules: [],
  };
}
