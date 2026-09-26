#!/usr/bin/env node
/**
 * check-native-artifacts.mjs — 原生构建产物自检 (2026-09-26)
 *
 * 为什么要它: 手机端要能"自己更新", 前提是**先有一个装上去的原生壳**。壳的版本必须和
 * npm `0.5.0` 对齐, 否则手机上会出现"App 是 0.4.x, 但 OTA 拉到的是 0.5.0"这种说不清的错配。
 *
 * 它做两件事, 并且**把"没构建"和"构建了但不对"分成两种结论**:
 *   ① 版本对齐 (纯静态检查, 任何机器都能跑): package.json ↔ android versionName/versionCode ↔ iOS MARKETING_VERSION
 *   ② 产物自检 (构建出来了才跑): 解开 .ipa / .apk, 核对里面的版本号与 mobile web 资源
 *
 * 退出码: 0 = 对齐检查过 (产物缺了只是"未构建", 不算失败); 1 = 版本对不齐 或 产物在里面但内容不对
 *
 * 用法: node scripts/check-native-artifacts.mjs
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const ROOT = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const want = pkg.version;                        // 权威: npm 版本
const parts = want.split('.').map((n) => parseInt(n, 10));
const wantCode = parts[0] * 10000 + parts[1] * 100 + parts[2];

const lines = [];
let failed = 0;
const ok = (t, d = '') => lines.push(`  ✅ ${t}${d ? ` — ${d}` : ''}`);
const bad = (t, d = '') => { failed++; lines.push(`  ❌ ${t}${d ? ` — ${d}` : ''}`); };
const skip = (t, d = '') => lines.push(`  ⊘  ${t}${d ? ` — ${d}` : ''}`);

// ── ① 版本对齐 ──────────────────────────────────────────────────────────────
const gradle = fs.readFileSync(path.join(ROOT, 'android/app/build.gradle'), 'utf8');
const gName = (gradle.match(/versionName\s+'([^']+)'/) || [])[1] || null;
const gCode = (gradle.match(/versionCode\s+(\d+)/) || [])[1] || null;
if (gName === want) ok('Android versionName 与 npm 版本对齐', `${gName}`);
else bad('Android versionName 与 npm 版本不一致', `android=${gName} npm=${want}`);
if (Number(gCode) === wantCode) ok('Android versionCode 与 npm 版本对齐', `${gCode} (= ${parts[0]}*10000+${parts[1]}*100+${parts[2]})`);
else bad('Android versionCode 与 npm 版本不一致', `android=${gCode} 期望=${wantCode}`);

const pbx = fs.readFileSync(path.join(ROOT, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8');
const iosVers = [...new Set([...pbx.matchAll(/MARKETING_VERSION\s*=\s*([^;]+);/g)].map((m) => m[1].trim()))];
if (iosVers.length === 1 && iosVers[0] === want) ok('iOS MARKETING_VERSION 与 npm 版本对齐', iosVers[0]);
else bad('iOS MARKETING_VERSION 与 npm 版本不一致', `ios=${iosVers.join('/')} npm=${want}`);
const iosBuild = [...new Set([...pbx.matchAll(/CURRENT_PROJECT_VERSION\s*=\s*([^;]+);/g)].map((m) => m[1].trim()))];
if (iosBuild.length === 1 && Number(iosBuild[0]) === wantCode) ok('iOS CURRENT_PROJECT_VERSION 与 versionCode 同一整数', `${iosBuild[0]} (= ${wantCode})`);
else bad('iOS CURRENT_PROJECT_VERSION 与 versionCode 不同一整数', `ios=${iosBuild.join('/')} 期望=${wantCode}`);

// ── ② 产物自检 ──────────────────────────────────────────────────────────────
const ipa = path.join(ROOT, 'build/ipa/Bolloon-unsigned.ipa');
const hasIpa = fs.existsSync(ipa);
if (!hasIpa) {
  skip('未签名 IPA 未构建 (本机): 需要 Xcode', '构建入口 bash scripts/ios-unsigned-ipa.sh');
} else {
  const list = execFileSync('unzip', ['-l', ipa], { encoding: 'utf8' });
  // 版本号要读**壳里那份 Info.plist**(二进制 plist), 不能只看文件名
  const toJson = (entry) => JSON.parse(execFileSync('sh', ['-c',
    `unzip -p ${JSON.stringify(ipa)} ${JSON.stringify(entry)} | plutil -convert json -o - -`], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
  let ver = null, bundle = null;
  try {
    const info = toJson('Payload/App.app/Info.plist');
    ver = info.CFBundleShortVersionString; bundle = info.CFBundleIdentifier;
  } catch (e) { bad('读不出 IPA 里的 Info.plist', String(e.message).slice(0, 80)); }
  if (ver === want) ok('IPA 里的版本号与 npm 版本对齐', `${ver} (bundle ${bundle})`);
  else if (ver) bad('IPA 里的版本号对不上', `ipa=${ver} npm=${want}`);
  // 壳里必须带着 **可 OTA 的那一层** 的"第一份": mobile.html + mobile.js + mobile-core.js (+ 构建戳)
  const need = ['mobile.html', 'mobile.js', 'mobile-core.js', 'bolloon-web.json'];
  const missing = need.filter((f) => !new RegExp(`Payload/App\\.app/public/${f.replace('.', '\\.')}`).test(list));
  if (!missing.length) ok('IPA 里带完整 mobile web 资源 (4 件)', 'mobile.html + mobile.js + mobile-core.js + 构建戳');
  else bad('IPA 里缺 mobile web 资源', `缺: ${missing.join(', ')}`);
}

const apkDir = path.join(ROOT, 'android/app/build/outputs/apk/debug');
const apks = fs.existsSync(apkDir) ? fs.readdirSync(apkDir).filter((f) => f.endsWith('.apk')) : [];
if (!apks.length) {
  skip('debug APK 未构建 (本机): 需要 JDK + Android SDK', '构建入口 cd android && ./gradlew assembleDebug');
} else {
  for (const f of apks) {
    const list = execFileSync('unzip', ['-l', path.join(apkDir, f)], { encoding: 'utf8' });
    const hasWeb = /assets\/public\/mobile\.html/.test(list);
    if (hasWeb) ok(`${f} 里带 mobile web 资源`, 'assets/public/mobile.html');
    else bad(`${f} 里没有 mobile web 资源`, '装了也打不开界面');
  }
}

// ── 结论 ────────────────────────────────────────────────────────────────────
console.log(`原生构建产物自检 (对齐基准: npm ${want} · versionCode ${wantCode})\n${lines.join('\n')}\n`);
const built = [];
if (hasIpa) built.push('IPA');
if (apks.length) built.push(`APK×${apks.length}`);
console.log(built.length ? `真构建出来并自检过的产物: ${built.join(', ')}` : '本机没有构建出任何原生产物 (上面 ⊘ 两条写明卡在哪)');
process.exit(failed === 0 ? 0 : 1);
