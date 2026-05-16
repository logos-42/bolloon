import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function loadArchiveMetadata(packageName: string): Record<string, unknown> {
  const snapshotPath = path.join(
    __dirname,
    'reference_data',
    'subsystems',
    `${packageName}.json`
  );
  return JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
}