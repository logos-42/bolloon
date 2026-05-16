import * as path from 'path';

export interface PortContext {
  sourceRoot: string;
  testsRoot: string;
  assetsRoot: string;
  archiveRoot: string;
  pythonFileCount: number;
  testFileCount: number;
  assetFileCount: number;
  archiveAvailable: boolean;
}

export function buildPortContext(base?: string): PortContext {
  const root = base || __dirname;
  const srcRoot = path.join(root, 'src');
  const testsRoot = path.join(root, 'tests');
  const assetsRoot = path.join(root, 'assets');
  const archiveRoot = path.join(root, 'archive');
  
  return {
    sourceRoot: srcRoot,
    testsRoot: testsRoot,
    assetsRoot: assetsRoot,
    archiveRoot: archiveRoot,
    pythonFileCount: 0,
    testFileCount: 0,
    assetFileCount: 0,
    archiveAvailable: false,
  };
}

export function renderContext(context: PortContext): string {
  return [
    `Source root: ${context.sourceRoot}`,
    `Test root: ${context.testsRoot}`,
    `Assets root: ${context.assetsRoot}`,
    `Archive root: ${context.archiveRoot}`,
    `Archive available: ${context.archiveAvailable}`,
  ].join('\n');
}
