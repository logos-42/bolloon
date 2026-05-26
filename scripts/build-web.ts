/**
 * Web 构建脚本
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { execSync } from 'child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST_WEB = path.join(ROOT, 'dist', 'web');
const DIST_COMPONENTS = path.join(DIST_WEB, 'components');
const DIST_P2P = path.join(DIST_COMPONENTS, 'p2p');
const DIST_UTILS = path.join(DIST_COMPONENTS, 'utils');

async function main() {
  console.log('[build-web] 开始构建...');

  // 清理并创建目录
  await fs.rm(DIST_WEB, { recursive: true, force: true });
  await fs.mkdir(DIST_COMPONENTS, { recursive: true });
  await fs.mkdir(DIST_P2P, { recursive: true });
  await fs.mkdir(DIST_UTILS, { recursive: true });

  // 编译主要组件
  console.log('[build-web] 编译主要组件...');
  execSync('npx tsc --ignoreConfig --outDir dist/web/components --declaration false --target ES2022 --module ESNext --moduleResolution bundler src/web/components/types.ts src/web/components/provider-card.ts src/web/components/provider-grid.ts src/web/components/config-modal.ts src/web/utils/cn.ts', {
    cwd: ROOT,
    stdio: 'inherit'
  });

  // 编译 P2P 组件（跳过类型错误）
  console.log('[build-web] 编译 P2P 组件...');
  const p2pFiles = [
    'src/web/components/p2p/types.ts',
    'src/web/components/p2p/p2p-store-memory.ts',
    'src/web/components/p2p/p2p-identity.ts',
    'src/web/components/p2p/p2p-connection.ts',
    'src/web/components/p2p/p2p-messages.ts',
    'src/web/components/p2p/p2p-manager.ts',
    'src/web/components/p2p/p2p-modal.ts',
    'src/web/components/p2p/index.ts'
  ];
  execSync(`npx tsc --ignoreConfig --outDir dist/web/components/p2p --declaration false --skipLibCheck --target ES2022 --module ESNext --moduleResolution bundler ${p2pFiles.join(' ')}`, {
    cwd: ROOT,
    stdio: 'inherit'
  });

  // 修复目录结构（tsc 会在 dist/web/components 下创建 components 子目录）
  const nestedComponents = path.join(DIST_COMPONENTS, 'components');
  if (await dirExists(nestedComponents)) {
    const files = await fs.readdir(nestedComponents);
    for (const file of files) {
      await fs.rename(path.join(nestedComponents, file), path.join(DIST_COMPONENTS, file));
    }
    await fs.rm(nestedComponents, { recursive: true });
  }

  // 复制静态文件
  console.log('[build-web] 复制静态文件...');
  await fs.copyFile(path.join(ROOT, 'src/web/index.html'), path.join(DIST_WEB, 'index.html'));
  await fs.copyFile(path.join(ROOT, 'src/web/api-config.html'), path.join(DIST_WEB, 'api-config.html'));
  await fs.copyFile(path.join(ROOT, 'src/web/style.css'), path.join(DIST_WEB, 'style.css'));
  await fs.copyFile(path.join(ROOT, 'src/web/client.js'), path.join(DIST_WEB, 'client.js'));
  await fs.copyFile(path.join(ROOT, 'src/web/twind.config.js'), path.join(DIST_WEB, 'twind.config.js'));

  // 复制 p2p-bundle.js（如果存在）
  const p2pBundleSrc = path.join(ROOT, 'src/web/p2p-bundle.js');
  try {
    await fs.access(p2pBundleSrc);
    await fs.copyFile(p2pBundleSrc, path.join(DIST_WEB, 'p2p-bundle.js'));
  } catch {
    // p2p-bundle.js 不存在，跳过
  }

  // 复制 utils 目录到 dist/web/utils
  await fs.mkdir(path.join(DIST_WEB, 'utils'), { recursive: true });
  if (await dirExists(path.join(DIST_COMPONENTS, 'utils'))) {
    const utilsFiles = await fs.readdir(path.join(DIST_COMPONENTS, 'utils'));
    for (const file of utilsFiles) {
      await fs.copyFile(path.join(DIST_COMPONENTS, 'utils', file), path.join(DIST_WEB, 'utils', file));
    }
  }

  // 复制 P2P 源文件（保留 .ts 供调试）
  await fs.cp(path.join(ROOT, 'src/web/components/p2p'), DIST_P2P, { recursive: true });

  console.log('[build-web] 完成!');
}

async function dirExists(p) {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

main().catch(console.error);