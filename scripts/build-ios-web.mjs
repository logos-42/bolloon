// 组装 iOS/Android web 目录: dist/web → dist/ios, 把 mobile.html 作为 index.html
// (Capacitor 固定加载 webDir/index.html; 手机端入口是 mobile.html)
import { cp, mkdir, readFile, writeFile, rm } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'dist/web');
const OUT = join(ROOT, 'dist/ios');

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await cp(SRC, OUT, { recursive: true });

// mobile.html → index.html (入口), 同时保留 mobile.html
const html = await readFile(join(SRC, 'mobile.html'), 'utf-8');
await writeFile(join(OUT, 'index.html'), html, 'utf-8');

console.log(`[build-ios-web] dist/ios 就绪 (index.html = mobile.html, ${html.length} bytes)`);
