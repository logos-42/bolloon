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
const APP_ID = 'com.hibs.bolloon';
// 2026-10-24: 架构跟随宿主 (CI 上 macos-14=arm64 / macos-13=x64 各出一份),
//   可用 BOLLOON_DESKTOP_ARCH 覆盖 (但 electron 二进制仍须与宿主架构一致, 交叉打不了)
const DESKTOP_ARCH = process.env.BOLLOON_DESKTOP_ARCH || process.arch;
const OUTPUT_DIR = path.join(ROOT, 'release', `mac-${DESKTOP_ARCH}`);
// 2026-10-24: 版本号不再写死 (老脚本硬编码 0.1.42, 与 package.json 脱节) —— 单一真源
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
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
  <string>${PKG_VERSION}</string>
  <key>CFBundleShortVersionString</key>
  <string>${PKG_VERSION}</string>
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

  log(`Copying package.json (with electron-builder extraMetadata)`);
  // 2026-10-24: 不能直接拷仓库 package.json —— 它的 main 是 CLI 入口 (dist/cli-entry.js),
  //   electron-builder 靠 build.extraMetadata 把它改成 Electron 主进程入口; 手搓脚本必须自己应用,
  //   否则启动的是 CLI (实测: spawn ERR_INVALID_ARG_TYPE 崩在 cli-entry)。
  const pkgRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const extraMeta = (pkgRaw.build && pkgRaw.build.extraMetadata) || {};
  const appPkg = {
    name: pkgRaw.name,
    productName: pkgRaw.build && pkgRaw.build.productName,
    version: pkgRaw.version,
    description: pkgRaw.description,
    author: pkgRaw.author,
    license: pkgRaw.license,
    // 2026-10-24: main 取 electron 入口; 但 type 必须 module —— dist/web/server.js 是 ESM,
    //   若设 commonjs (electron-builder extraMetadata 默认) 会让 web server 子进程 SyntaxError 秒退 ⇒ 白屏。
    //   (electron 主入口是 CJS, Electron 主进程对主脚本有专门加载路径, 不受 type:module 影响)
    main: extraMeta.main,
    type: 'module',
  };
  fs.writeFileSync(path.join(appContentDir, 'package.json'), JSON.stringify(appPkg, null, 2));
  // 2026-10-24: 写入打包标记, 供 src/electron/config.ts 的 isDev 判定 (手搓包 app.isPackaged 不可靠)
  fs.writeFileSync(path.join(appContentDir, '.bolloon-packaged'), '');

  // 2026-10-24: electron 主进程链 (dist/electron-build) 是 CommonJS, 其余 dist/ 是 ESM
  //   (根 type:module)。Electron 加载主进程按「最近的 package.json」判模块形态 ——
  //   dist/electron-build 必须自带 {"type":"commonjs"}, 否则 require/module.exports 崩。
  //   build:electron 已通过 scripts/electron-build-marker.cjs 写入; 这里幂等补一道
  //   (单独跑 app:bundle 不走 build:electron 时也不缺)。
  {
    const ebDir = path.join(appContentDir, 'dist', 'electron-build');
    fs.mkdirSync(ebDir, { recursive: true });
    fs.writeFileSync(path.join(ebDir, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
  }

  log(`Copying node_modules/ (prod closure only) — this is the slow part`);
  // 不能用 rsync 因为 OOM, 用 cp -R
  const srcNm = path.join(ROOT, 'node_modules');
  const dstNm = path.join(appContentDir, 'node_modules');
  fs.mkdirSync(dstNm, { recursive: true });
  // 2026-10-24: 老实现按顶层目录全拷 ⇒ devDependencies (vitest/typescript/electron…) 全进包, 2.0G。
  //   改为只拷 `npm ls --omit=dev --all --parseable` 的生产闭包; 只取顶层包 (嵌套随父包递归带走)。
  const entries = (() => {
    let out = '';
    try {
      out = execSync('npm ls --omit=dev --all --parseable', {
        cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024,
      });
    } catch (e) {
      out = (e && e.stdout) || '';
    }
    const tops = new Set();
    for (const line of out.split('\n')) {
      const abs = line.trim();
      if (!abs || !abs.includes('node_modules')) continue;
      const rel = path.relative(srcNm, abs);
      if (!rel || rel.startsWith('..')) continue;
      const parts = rel.split(path.sep);
      // 只保留顶层 (含 @scope/name 两段); 嵌套 node_modules 由父包递归带走
      if (parts.includes('node_modules')) continue;
      if (parts.length === 1) tops.add(parts[0]);
      else if (parts.length === 2) tops.add(parts.join('/'));
    }
    // 空闭包 (npm ls 失败) ⇒ 回退到全量, 保证能跑而不是打出坏包
    if (!tops.size) {
      log('[warn] npm ls 未给出生产闭包, 回退为全量拷贝');
      return fs.readdirSync(srcNm).filter((n) => !n.startsWith('.'));
    }
    return [...tops].filter((n) => fs.existsSync(path.join(srcNm, n.split('/')[0])));
  })();
  let count = 0;
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const src = path.join(srcNm, name);
    const dst = path.join(dstNm, name);
    fs.cpSync(src, dst, { recursive: true, dereference: false, filter: (s) => {
      // 跳过 .bin, .cache, .package-lock.json
      const base = path.basename(s);
      if (base === '.bin' || base === '.cache' || base === '.package-lock.json') return false;
      // 2026-10-24: 只跳过运行期绝对用不到的「文件」(编译产物/类型/文档), 不跳目录 ——
      //   依赖里有些运行期必需文件恰好放在 test/ docs/ 目录下 (如 viem 的 _esm/actions/test/), 跳目录会缺模块。
      if (/\.(?:map|d\.ts)$/.test(base)) return false;
      if (/^(?:README|CHANGELOG|LICENSE|AUTHORS|NOTICE)(?:\..*)?$/i.test(base)) return false;
      if (/\.(?:md|markdown|markdown\.md)$/i.test(base)) return false;
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

  // 复制 build/ 的**图标** → Resources/build/ (tray/window 图标用)
  // 2026-10-24: 老实现整目录 copyDir ⇒ 把 dd/ ipa/ mobile-web/ 等产物 (486M) 全打进包。
  //   运行期只需要 tray.png / icon.png。
  const buildSrc = path.join(ROOT, 'build');
  if (fs.existsSync(buildSrc)) {
    // 2026-10-24: 手搓包里 app.isPackaged=false, buildResourcesDir() 回退到 app/build,
    //   所以图标要同时放进 Resources/build (packaged 态) 和 app/build (手搓态), 否则托盘图标缺失。
    const targets = [
      path.join(TARGET_APP, 'Contents', 'Resources', 'build'),
      path.join(appContentDir, 'build'),
    ];
    for (const dir of targets) {
      fs.mkdirSync(dir, { recursive: true });
      for (const f of ['tray.png', 'trayTemplate.png', 'icon.png', 'icon.icns', 'icon.ico']) {
        const from = path.join(buildSrc, f);
        if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dir, f));
      }
    }
    log(`Copied build icons → Resources/build/ + app/build/ (tray.* / icon.*)`);
  }

  log(`Done. App bundle: ${TARGET_APP}`);
  log(`To run: open "${TARGET_APP}"`);
}

main();
