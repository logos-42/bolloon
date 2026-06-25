/**
 * Capacitor 配置 — Bolloon Agent iOS 包
 *
 * webDir: 'dist/web' → `npx cap sync ios` 会把 dist/web/* 拷到 ios/App/App/public/
 * server.url: dev 时用本地 server, prod (Capacitor 打包) 时清空走 webDir
 *
 * iOS 后端限制 (跟 Electron 同):
 * - P2P 后台被 iOS 杀 (suspended 30s), 跨机 @-mention 在锁屏后会断
 * - localStorage 限 5MB (用 Capacitor Preferences API 替代会更好, 后面再做)
 */
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.bolloon.agent',
  appName: 'Bolloon Agent',
  webDir: 'dist/web',
  // 不配 server.url → prod build 用 webDir 本地资源 (相对路径 fetch)
  // dev 时在终端用 `npx cap run ios --livereload --external` 走 livereload
  bundledWebRuntime: false,
  ios: {
    contentInset: 'automatic',
    // iOS 17+ WKWebView 限制 HTTP 明文, 需要 App Transport Security 放行 loopback
    // (我们在 ios/App/App/Info.plist 里加 NSAppTransportSecurity)
    backgroundColor: '#ffffff',
  },
  android: {
    // 暂不实现 Android, 留空
  },
  server: {
    // dev 用: 在 macOS 跑 `npm run dev:web` 然后 `npx cap run ios --livereload --external`
    // 实际访问 http://192.168.x.x:54188 (iPhone 与 Mac 同网段)
    androidScheme: 'https',
  },
};

export default config;
