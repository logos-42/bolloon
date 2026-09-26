// 组装 iOS/Android web 目录: dist/web → dist/ios, 把 mobile.html 作为 index.html
// (Capacitor 固定加载 webDir/index.html; 手机端入口是 mobile.html)
//
// 2026-09-26 追加: **手机端原生壳的版本标识也从 package.json 派生** (不再手抄第二个数字)。
//   为什么: 壳的 `Android versionName/versionCode` 与 `iOS MARKETING_VERSION/CURRENT_PROJECT_VERSION`
//   是"手机端 build 的版本标识", 但它们写在 gradle / pbxproj 里, 与 `package.json` 是两处数字。
//   手抄的下场是"App 是 0.5.0, 但 OTA 拉到的是 0.5.1"这种说不清的错配。
//   这里在出包前(scripts/build-ios.sh 第②步)把它们**按同一个源重写**; 已有的
//   `scripts/check-native-artifacts.mjs` 仍然独立核对一遍 (本脚本 ≠ 校验, 校验另有一门)。
import { cp, mkdir, readFile, writeFile, rm } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'dist/web');
const OUT = join(ROOT, 'dist/ios');

// ── 单一真源: package.json 的 version ───────────────────────────────────────
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf-8'));
const version = String(pkg.version);
const parts = version.split('.').map((n) => parseInt(n, 10));
if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
  console.error(`[build-ios-web] ✗ package.json version "${version}" 不是三段 semver —— 拒绝继续 (不猜版本号)`);
  process.exit(2);
}
const versionCode = parts[0] * 10000 + parts[1] * 100 + parts[2];

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await cp(SRC, OUT, { recursive: true });

// mobile.html → index.html (入口), 同时保留 mobile.html
const html = await readFile(join(SRC, 'mobile.html'), 'utf-8');
await writeFile(join(OUT, 'index.html'), html, 'utf-8');

// ── 原生壳版本对齐 (派生: package.json → gradle / pbxproj) ──────────────────
const changed = [];

const gradlePath = join(ROOT, 'android/app/build.gradle');
const gradle = await readFile(gradlePath, 'utf-8');
if (!/versionName\s+'[^']+'/.test(gradle) || !/versionCode\s+\d+/.test(gradle)) {
  console.error('[build-ios-web] ✗ android/app/build.gradle 里找不到 versionName/versionCode —— 拒绝静默跳过');
  process.exit(1);
}
const gradleNext = gradle
  .replace(/versionName\s+'[^']+'/, `versionName '${version}'`)
  .replace(/versionCode\s+\d+/, `versionCode ${versionCode}`);
if (gradleNext !== gradle) { await writeFile(gradlePath, gradleNext, 'utf-8'); changed.push(`android/app/build.gradle → versionName '${version}' · versionCode ${versionCode}`); }

const pbxPath = join(ROOT, 'ios/App/App.xcodeproj/project.pbxproj');
const pbx = await readFile(pbxPath, 'utf-8');
if (!/MARKETING_VERSION\s*=\s*[^;]+;/.test(pbx) || !/CURRENT_PROJECT_VERSION\s*=\s*\d+;/.test(pbx)) {
  console.error('[build-ios-web] ✗ iOS project.pbxproj 里找不到 MARKETING_VERSION/CURRENT_PROJECT_VERSION —— 拒绝静默跳过');
  process.exit(1);
}
const pbxNext = pbx
  .replace(/MARKETING_VERSION\s*=\s*[^;]+;/g, `MARKETING_VERSION = ${version};`)
  .replace(/CURRENT_PROJECT_VERSION\s*=\s*\d+;/g, `CURRENT_PROJECT_VERSION = ${versionCode};`);
if (pbxNext !== pbx) { await writeFile(pbxPath, pbxNext, 'utf-8'); changed.push(`ios/App/App.xcodeproj/project.pbxproj → MARKETING_VERSION ${version} · CURRENT_PROJECT_VERSION ${versionCode}`); }

console.log(`[build-ios-web] dist/ios 就绪 (index.html = mobile.html, ${html.length} bytes)`);
console.log(`[build-ios-web] 原生壳版本 = ${version} (${versionCode}) ← package.json (单一真源)`);
if (changed.length) for (const c of changed) console.log(`[build-ios-web] 已重写: ${c}`);
else console.log('[build-ios-web] gradle / pbxproj 已经是这个版本, 未改动');
