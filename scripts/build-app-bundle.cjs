/**
 * scripts/build-app-bundle.js
 *
 * 手搓 macOS .app bundle, 完全绕过 electron-builder 的 npm walker
 * (那个 walker 在 1.1G @rayhanadev + app-builder-lib@26.x 下 OOM, 见
 *  memory/electron-pack-oom-2026-06-24.md).
 *
 * 步骤:
 *   1. 复制 node_modules/electron/dist/Electron.app → release/mac-arm64/Bolloon Agent.app
 *   2. 替换 Contents/Info.plist + PkgInfo + icon.icns
 *   3. 复制 dist/ + node_modules/ + package.json → Contents/Resources/app/
 *   4. (可选) 复制 build/tray.png → Contents/Resources/build/ (给 tray 用)
 *
 * 输出: release/mac-arm64/Bolloon Agent.app (可直接 open /Applications)
 * 不生成 .dmg — 用 electron-builder --prepackaged 后续可补 (但现在跳过)
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const ELECTRON_APP = path.join(ELECTRON_DIST, 'Electron.app');
const APP_NAME = 'Bolloon Agent';
const PRODUCT_NAME = 'Bolloon Agent';
const APP_ID = 'com.bolloon.agent';
const OUTPUT_DIR = path.join(ROOT, 'release', 'mac-arm64');
const TARGET_APP = path.join(OUTPUT_DIR, `${APP_NAME}.app`);

function log(msg) {
  console.log(`[build-app-bundle] ${msg}`);
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  execSync(`cp -R "${src}/." "${dst}/"`, { stdio: 'inherit' });
}

function writeInfoPlist(appPath) {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleExecutable</key>
  <string>Electron</string>
  <key>CFBundleIdentifier</key>
  <string>${APP_ID}</string>
  <key>CFBundleVersion</key>
  <string>0.1.42</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.42</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleSignature</key>
  <string>????</string>
  <key>LSMinimumSystemVersion</key>
  <string>10.13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.productivity</string>
  <key>NSSupportsAutomaticGraphicsSwitching</key>
  <true/>
  <key>ElectronAsarIntegrity</key>
  <dict/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
</dict>
</plist>
`;
  fs.writeFileSync(path.join(appPath, 'Contents', 'Info.plist'), plist);
  fs.writeFileSync(path.join(appPath, 'Contents', 'PkgInfo'), 'APPL????');
}

function main() {
  if (!fs.existsSync(ELECTRON_APP)) {
    console.error(`[build-app-bundle] FATAL: ${ELECTRON_APP} not found. Run: node node_modules/electron/install.js`);
    process.exit(1);
  }

  log(`Cleaning ${OUTPUT_DIR}`);
  rmrf(OUTPUT_DIR);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  log(`Copying Electron.app → ${TARGET_APP}`);
  copyDir(ELECTRON_APP, TARGET_APP);

  log(`Writing Info.plist + PkgInfo`);
  writeInfoPlist(TARGET_APP);

  // 替换 icon
  const iconSrc = path.join(ROOT, 'build', 'icon.icns');
  if (fs.existsSync(iconSrc)) {
    log(`Copying icon: ${iconSrc}`);
    fs.copyFileSync(iconSrc, path.join(TARGET_APP, 'Contents', 'Resources', 'electron.icns'));
  } else {
    log(`WARN: ${iconSrc} missing — app will use default Electron icon`);
  }

  // 复制 app 内容 → Contents/Resources/app/
  const appContentDir = path.join(TARGET_APP, 'Contents', 'Resources', 'app');
  log(`Building app content dir: ${appContentDir}`);
  rmrf(appContentDir);
  fs.mkdirSync(appContentDir, { recursive: true });

  log(`Copying dist/`);
  copyDir(path.join(ROOT, 'dist'), path.join(appContentDir, 'dist'));

  log(`Copying package.json`);
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(appContentDir, 'package.json'));

  log(`Copying node_modules/ (excluding devDeps) — this is the slow part`);
  // 不能用 rsync 因为 OOM, 用 cp -R
  const srcNm = path.join(ROOT, 'node_modules');
  const dstNm = path.join(appContentDir, 'node_modules');
  fs.mkdirSync(dstNm, { recursive: true });
  // 排除大且 dev-only 的 packages, 但 @rayhanadev 必须保留 (生产代码用)
  const entries = fs.readdirSync(srcNm);
  let count = 0;
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const src = path.join(srcNm, name);
    const dst = path.join(dstNm, name);
    fs.cpSync(src, dst, { recursive: true, dereference: false, filter: (s) => {
      // 跳过 .bin, .cache, .package-lock.json
      const base = path.basename(s);
      if (base === '.bin' || base === '.cache' || base === '.package-lock.json') return false;
      // 跳过 doc/test/assets 巨型 dir, 运行时不需要
      if (base === 'test' || base === 'docs' || base === '__tests__') return false;
      return true;
    }});
    count++;
    if (count % 20 === 0) log(`  copied ${count}/${entries.length} node_modules/*`);
  }
  log(`Copied ${count} node_modules entries`);

  // 复制 bin/
  const binSrc = path.join(ROOT, 'bin');
  if (fs.existsSync(binSrc)) {
    log(`Copying bin/`);
    copyDir(binSrc, path.join(appContentDir, 'bin'));
  }

  // 复制 build/ → Resources/build/ (tray 图标用)
  const buildSrc = path.join(ROOT, 'build');
  if (fs.existsSync(buildSrc)) {
    log(`Copying build/ → Resources/build/`);
    copyDir(buildSrc, path.join(TARGET_APP, 'Contents', 'Resources', 'build'));
  }

  log(`Done. App bundle: ${TARGET_APP}`);
  log(`To run: open "${TARGET_APP}"`);
}

main();
