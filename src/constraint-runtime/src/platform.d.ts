// 2026-08-02: platform 包 (platform.js) 无自带类型声明, tsc --moduleResolution NodeNext 报 TS7016
// 最小声明, 只覆盖 setup.ts 用到的字段 (ESM 风格, NodeNext 兼容)
declare module 'platform' {
  interface PlatformInfo {
    name?: string;
    version?: string;
    os?: { toString(): string };
    description?: string;
    layout?: string;
    manufacturer?: string;
    product?: string;
  }
  const platform: PlatformInfo;
  export default platform;
}
