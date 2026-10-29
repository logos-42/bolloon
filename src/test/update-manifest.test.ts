import { describe, it, expect } from 'vitest';
import { inferPlatformKey } from '../../scripts/gen-update-manifest';

// 平台键映射是更新能否真实落地的关键: Tauri 按 {target}-{arch} 在清单里查条目,
// 键错了更新包就永远对不上 → 检查永远报 "无更新/不兼容版本"。这里锁死映射。
describe('inferPlatformKey (Tauri 更新包 → 平台键)', () => {
  it('macOS aarch64', () => {
    expect(inferPlatformKey('macos/Bolloon_aarch64.app.tar.gz')).toBe('darwin-aarch64');
  });
  it('macOS x86_64', () => {
    expect(inferPlatformKey('macos/Bolloon_x86_64.app.tar.gz')).toBe('darwin-x86_64');
  });
  it('macOS universal', () => {
    expect(inferPlatformKey('macos/Bolloon_universal.app.tar.gz')).toBe('darwin-universal');
  });
  it('Windows NSIS x64', () => {
    expect(inferPlatformKey('nsis/Bolloon_x64.nsis')).toBe('windows-x86_64');
  });
  it('Windows NSIS arm64', () => {
    expect(inferPlatformKey('nsis/Bolloon_arm64.nsis')).toBe('windows-aarch64');
  });
  it('Windows setup.exe (含 -setup)', () => {
    expect(inferPlatformKey('nsis/Bolloon_x64-setup.nsis')).toBe('windows-x86_64');
  });
  it('Linux AppImage amd64 (默认 x86_64)', () => {
    expect(inferPlatformKey('appimage/Bolloon.AppImage')).toBe('linux-x86_64');
  });
  it('Linux AppImage aarch64', () => {
    expect(inferPlatformKey('appimage/Bolloon_aarch64.AppImage')).toBe('linux-aarch64');
  });
  it('无法识别的产物返回 null', () => {
    expect(inferPlatformKey('foo/bar.zip')).toBeNull();
    expect(inferPlatformKey('some/random/file')).toBeNull();
  });
});
