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

  // 重要: 不能 rm -rf 整个 dist/web/, 否则会删掉 build:main 编译出来的
  // dist/web/server.js. 只清理 web 静态资源, 保留 server.js.
  for (const f of ['index.html', 'api-config.html', 'style.css', 'client.js', 'components']) {
    await fs.rm(path.join(DIST_WEB, f), { recursive: true, force: true });
  }
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
    execSync(`npx tsc --outDir dist/web/components/p2p --declaration false --skipLibCheck --target ES2022 --module ESNext --moduleResolution bundler ${moduleFiles.join(' ')}`, {
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

  // 2026-06-15: 编译 message-renderer.ts (对话显示 UI 模块)
  //   esbuild 编译 .ts → dist/web/ui/message-renderer.js (ESM, 浏览器侧 <script type="module"> 加载)
  console.log('[build-web] 编译 message-renderer.ts...');
  await fs.mkdir(path.join(DIST_WEB, 'ui'), { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/web/ui/message-renderer.ts')],
    outfile: path.join(DIST_WEB, 'ui/message-renderer.js'),
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
  // 复制 PWA manifest (index.html 里有 <link rel="manifest">, 否则浏览器会 404)
  await fs.copyFile(path.join(ROOT, 'src/web/manifest.json'), path.join(DIST_WEB, 'manifest.json'));
  // 复制 icons 目录 (manifest.json 里引用了 favicon 等)
  await fs.cp(path.join(ROOT, 'src/web/icons'), path.join(DIST_WEB, 'icons'), { recursive: true });

  // 复制 components/ 下的独立 ESM 模块 (非 p2p 那些, 已被 esbuild 单独编译)
  // 例如 wallet-viem.mjs: 浏览器侧 viem 封装, 被 index.html 引用
  const extraComponentsDir = path.join(ROOT, 'src/web/components');
  for (const entry of await fs.readdir(extraComponentsDir)) {
    if (entry === 'p2p') continue;
    const src = path.join(extraComponentsDir, entry);
    const dest = path.join(DIST_WEB, 'components', entry);
    const stat = await fs.stat(src);
    if (stat.isFile()) {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
    }
  }

  console.log('[build-web] 完成!');
}

main().catch(console.error);
