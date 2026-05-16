import * as fs from 'fs';
import * as path from 'path';

export function loadArchiveMetadata(packageName: string): Record<string, unknown> {
  const snapshotPath = path.join(
    __dirname,
    'reference_data',
    'subsystems',
    `${packageName}.json`
  );
  return JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
}
