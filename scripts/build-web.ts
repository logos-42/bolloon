/**
 * Web 构建脚本
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { execSync } from 'child_process';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST_WEB = path.join(ROOT, 'dist', 'web');

async function main() {
  console.log('[build-web] 开始构建...');

  // 清理并创建目录
  await fs.rm(DIST_WEB, { recursive: true, force: true });
  await fs.mkdir(DIST_WEB, { recursive: true });
  await fs.mkdir(path.join(DIST_WEB, 'components', 'p2p'), { recursive: true });

  // 编译 TypeScript 模块
  console.log('[build-web] 编译 TypeScript 模块...');
  const moduleFiles = [
    'src/web/components/p2p/types.ts',
    'src/web/components/p2p/p2p-store-memory.ts',
    'src/web/components/p2p/p2p-identity.ts',
    'src/web/components/p2p/p2p-connection.ts',
    'src/web/components/p2p/p2p-messages.ts',
    'src/web/components/p2p/p2p-manager.ts',
  ];

  try {
    execSync(`npx tsc --ignoreConfig --outDir dist/web/components/p2p --declaration false --skipLibCheck --target ES2022 --module ESNext --moduleResolution bundler ${moduleFiles.join(' ')}`, {
      cwd: ROOT,
      stdio: 'inherit'
    });
  } catch {
    console.log('[build-web] TypeScript 编译有警告，继续...');
  }

  // 编译 P2P Modal UI（esbuild）
  console.log('[build-web] 编译 P2P Modal UI...');
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/web/components/p2p/index.ts')],
    outfile: path.join(DIST_WEB, 'components/p2p/index.js'),
    format: 'esm',
    target: 'es2022',
    platform: 'browser',
    minify: false,
  });

  // 复制静态文件
  console.log('[build-web] 复制静态文件...');
  await fs.copyFile(path.join(ROOT, 'src/web/index.html'), path.join(DIST_WEB, 'index.html'));
  await fs.copyFile(path.join(ROOT, 'src/web/api-config.html'), path.join(DIST_WEB, 'api-config.html'));
  await fs.copyFile(path.join(ROOT, 'src/web/style.css'), path.join(DIST_WEB, 'style.css'));
  await fs.copyFile(path.join(ROOT, 'src/web/client.js'), path.join(DIST_WEB, 'client.js'));

  console.log('[build-web] 完成!');
}

main().catch(console.error);
