/**
 * Web 构建脚本 - 简化版
 */
import * as fs from 'fs/promises';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST_WEB = path.join(ROOT, 'dist', 'web');

async function main() {
  console.log('[build-web] 开始构建...');

  // 清理并创建目录
  await fs.rm(DIST_WEB, { recursive: true, force: true });
  await fs.mkdir(DIST_WEB, { recursive: true });
  await fs.mkdir(path.join(DIST_WEB, 'components', 'p2p'), { recursive: true });

  // 复制静态文件
  console.log('[build-web] 复制静态文件...');
  await fs.copyFile(path.join(ROOT, 'src/web/index.html'), path.join(DIST_WEB, 'index.html'));
  await fs.copyFile(path.join(ROOT, 'src/web/api-config.html'), path.join(DIST_WEB, 'api-config.html'));
  await fs.copyFile(path.join(ROOT, 'src/web/style.css'), path.join(DIST_WEB, 'style.css'));
  await fs.copyFile(path.join(ROOT, 'src/web/client.js'), path.join(DIST_WEB, 'client.js'));

  // 复制 P2P 源文件
  console.log('[build-web] 复制 P2P 组件...');
  await fs.cp(path.join(ROOT, 'src/web/components/p2p'), path.join(DIST_WEB, 'components/p2p'), { recursive: true });

  console.log('[build-web] 完成!');
}

main().catch(console.error);
