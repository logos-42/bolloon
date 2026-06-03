/**
 * 缺失类型模块的兜底声明 — 让 strict tsc 通过, 避免阻塞发布。
 * 这些是项目里实际使用但 @types 包未安装或缺失的小依赖。
 */
declare module 'js-yaml' {
  const yaml: {
    load: (str: string) => any;
    dump: (obj: any, opts?: any) => string;
  };
  export default yaml;
  export = yaml;
}
