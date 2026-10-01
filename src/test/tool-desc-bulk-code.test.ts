/**
 * "创建大量代码"的分工必须写在**工具描述**里 (2026-10-01, 用户: 「终端工具里有没有直接创建大量代码的功能」)。
 *
 * 调研结论 (对照运行时那套的做法): 建文件的正路是 **write_file**; 终端不该用来 heredoc/echo 造文件
 *   (容易转义出错、也看不出写了什么)。而 bolloon 原来的口径有三处会把人带偏:
 *     ① write_file 有 **100KB 硬上限** ⇒ "写个大文件"被迫分块 ⇒ 反而变成多次零碎调用;
 *     ② execute_code 的描述只说"计算/数据处理" ⇒ **没告诉模型它能一次写 N 个文件**;
 *     ③ terminal 的描述**鼓励**"写 HTML 文件/重定向" ⇒ 把建文件引向了最难核对的那条路。
 * 这条门用**源级**核对把这些口径钉住 (工具描述是模型的唯一说明书, 它错了整条行为就错)。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(path.join(process.cwd(), 'src/agents/pi-sdk-tools.ts'), 'utf-8');

describe('工具描述里的"建代码"分工', () => {
  it('write_file: 上限已从 100KB 抬到 2MB, 并指引多文件走 execute_code', () => {
    expect(SRC).not.toContain('content.length > 100_000');
    expect(SRC).toContain('content.length > 2_000_000');
    expect(SRC).toMatch(/execute_code[^。]*一次写完|一次写完\(一次调用写 N 个文件/);
  });
  it('execute_code: 明确它是"一次生成大量代码"的推荐路径', () => {
    const i = SRC.indexOf("ctx.tools.set('execute_code'");
    const block = SRC.slice(i, i + 1200);
    expect(block).toContain('大量代码');
    expect(block).toMatch(/推荐路径|一次调用顶|写多个文件/);
  });
  it('terminal: 造文件要让位给 write_file / execute_code (别再鼓励重定向写文件)', () => {
    const i = SRC.indexOf("ctx.tools.set('terminal'");
    const block = SRC.slice(i, i + 900);
    expect(block).toMatch(/造文件请优先用 write_file \/ execute_code|优先用 write_file/);
  });
});
