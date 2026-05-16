import * as path from 'path';
import { fileURLToPath } from 'url';
import { Subsystem } from './models.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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