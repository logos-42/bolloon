/**
 * efficode - AI 专用交流语言的**参考实现** (v0.1.0)
 *
 * 模块划分:
 *   types.ts      公共类型 / 失败码
 *   ops.ts        指令集与词典 (符号 ↔ 二进制操作码, 前缀表达式)
 *   crc32.ts      包尾 CRC32 (纯 JS, 任何运行面可算)
 *   lz77.ts       自解压数据块用的轻量 LZ77 (真实实现)
 *   compress.ts   可插拔压缩层 (none / lz77 / deflate)
 *   did.ts        DID 验证段 (32B 摘要段)
 *   packet.ts     包封装: [Header 2B]|[DID 32B]|[指令段]|[数据块]|[CRC32 4B]
 *   negotiate.ts  智能体"用哪种语言"的声明/协商/回落与记录
 *
 * 状态的**唯一事实源**在 docs/wiki/efficode.md 的逐节标注 (已实现 / 规范中 / 未实现);
 * 本目录只提供代码, 代码里的注释只写"这段代码真做了什么"。
 */

export * from './types.js';
export * from './ops.js';
export * from './crc32.js';
export * from './lz77.js';
export * from './compress.js';
export * from './did.js';
export * from './packet.js';
export * from './negotiate.js';
