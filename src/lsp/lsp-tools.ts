/**
 * lsp/lsp-tools.ts — 注册 LSP 工具到 Bolloon agent 工具系统
 *
 * 暴露 6 个工具:
 *   - lsp_detect: 检测本机已安装的语言服务器
 *   - lsp_hover: 悬停查看类型/文档
 *   - lsp_completion: 代码补全
 *   - lsp_diagnostics: 诊断当前文件
 *   - lsp_go_to_definition: 跳转到定义
 *   - lsp_start / lsp_stop: 手动管理 LSP 服务器生命周期
 */

import type { Tool, ToolResult } from '../agents/pi-sdk-types.js';
import {
  detectInstalledLspServers,
  startLspServer,
  stopLspServer,
  stopAllLspServers,
  findLspForFile,
  lspDidOpen,
  lspHover,
  lspCompletion,
  lspDiagnostics,
  lspGoToDefinition,
  type LspServerSpec,
} from './lsp-manager.js';

interface ToolRegistryContext {
  tools: Map<string, Tool>;
}

/** 已检测到的 LSP 服务器列表 (缓存) */
let cachedSpecs: LspServerSpec[] | null = null;

async function getSpecs(): Promise<LspServerSpec[]> {
  if (!cachedSpecs) cachedSpecs = await detectInstalledLspServers();
  return cachedSpecs;
}

/**
 * 注册 6 个 LSP 工具到 Bolloon agent 的工具系统.
 * 在 registerBuiltinTools 内部调用.
 */
export function registerLspTools(ctx: ToolRegistryContext): void {
  ctx.tools.set('lsp_detect', {
    name: 'lsp_detect',
    description: '检测本机已安装的 LSP (Language Server Protocol) 服务器, 返回可用的语言列表',
    parameters: {},
    execute: async (_args): Promise<ToolResult> => {
      try {
        const specs = await getSpecs();
        if (specs.length === 0) {
          return { success: true, output: '⚠️ 未检测到任何 LSP 服务器。可安装:\n  npm install -g typescript-language-server\n  cargo install rust-analyzer' };
        }
        const lines = specs.map(s => `  ✅ ${s.displayName} (${s.language}): ${s.fileExtensions.join(', ')}`);
        return { success: true, output: `已检测到 ${specs.length} 个 LSP 服务器:\n${lines.join('\n')}` };
      } catch (e: any) {
        return { success: false, error: String(e) };
      }
    },
  });

  ctx.tools.set('lsp_start', {
    name: 'lsp_start',
    description: '启动指定语言的语言服务器 (如 typescript / rust / python)',
    parameters: { language: '语言 id, 如 typescript / rust / python (必填)' },
    execute: async (args): Promise<ToolResult> => {
      try {
        const language = String(args.language || '').trim().toLowerCase();
        if (!language) return { success: false, error: 'language 必填' };
        const inst = await startLspServer(language);
        if (!inst) return { success: false, error: `未找到 ${language} 的 LSP 服务器, 请先安装` };
        return { success: true, output: `✅ ${inst.spec.displayName} 已启动` };
      } catch (e: any) {
        return { success: false, error: String(e) };
      }
    },
  });

  ctx.tools.set('lsp_hover', {
    name: 'lsp_hover',
    description: '在文件某位置悬停, 查看类型/文档 (需要先 lsp_start)',
    parameters: {
      file: '文件路径 (必填)',
      line: '行号 (从 0 开始)',
      character: '列号 (从 0 开始)',
      content: '文件内容 (可选, 首次需要以触发 didOpen)',
    },
    execute: async (args): Promise<ToolResult> => {
      try {
        const file = String(args.file || '').trim();
        if (!file) return { success: false, error: 'file 必填' };
        const line = parseInt(String(args.line || '0'), 10);
        const character = parseInt(String(args.character || '0'), 10);
        const content = args.content ? String(args.content) : undefined;

        const specs = await getSpecs();
        const spec = findLspForFile(file, specs);
        if (!spec) return { success: false, error: `未找到 ${file} 对应的 LSP 服务器` };

        const inst = await startLspServer(spec.language);
        if (!inst) return { success: false, error: `LSP ${spec.language} 启动失败` };

        if (content) lspDidOpen(inst, file, content);
        const result = await lspHover(inst, file, line, character);
        if (!result) return { success: true, output: '(无悬停信息)' };
        return { success: true, output: result.contents };
      } catch (e: any) {
        return { success: false, error: String(e) };
      }
    },
  });

  ctx.tools.set('lsp_completion', {
    name: 'lsp_completion',
    description: '在文件某位置获取代码补全建议 (需要先 lsp_start)',
    parameters: {
      file: '文件路径 (必填)',
      line: '行号 (从 0 开始)',
      character: '列号 (从 0 开始)',
      content: '文件内容 (可选)',
    },
    execute: async (args): Promise<ToolResult> => {
      try {
        const file = String(args.file || '').trim();
        if (!file) return { success: false, error: 'file 必填' };
        const line = parseInt(String(args.line || '0'), 10);
        const character = parseInt(String(args.character || '0'), 10);
        const content = args.content ? String(args.content) : undefined;

        const specs = await getSpecs();
        const spec = findLspForFile(file, specs);
        if (!spec) return { success: false, error: `未找到 ${file} 对应的 LSP 服务器` };

        const inst = await startLspServer(spec.language);
        if (!inst) return { success: false, error: `LSP ${spec.language} 启动失败` };

        if (content) lspDidOpen(inst, file, content);
        const result = await lspCompletion(inst, file, line, character);
        if (result.items.length === 0) return { success: true, output: '(无补全建议)' };
        const items = result.items.slice(0, 20).map(i => `  ${i.label}${i.detail ? ` — ${i.detail}` : ''}`);
        return { success: true, output: `补全建议 (显示前 20 条):\n${items.join('\n')}` };
      } catch (e: any) {
        return { success: false, error: String(e) };
      }
    },
  });

  ctx.tools.set('lsp_diagnostics', {
    name: 'lsp_diagnostics',
    description: '获取文件的诊断结果 (错误/警告)',
    parameters: { file: '文件路径 (必填)', content: '文件内容 (可选)' },
    execute: async (args): Promise<ToolResult> => {
      try {
        const file = String(args.file || '').trim();
        if (!file) return { success: false, error: 'file 必填' };
        const content = args.content ? String(args.content) : undefined;

        const specs = await getSpecs();
        const spec = findLspForFile(file, specs);
        if (!spec) return { success: false, error: `未找到 ${file} 对应的 LSP 服务器` };

        const inst = await startLspServer(spec.language);
        if (!inst) return { success: false, error: `LSP ${spec.language} 启动失败` };

        if (content) lspDidOpen(inst, file, content);
        const result = await lspDiagnostics(inst, file);
        if (result.diagnostics.length === 0) return { success: true, output: '✅ 无诊断问题' };
        const lines = result.diagnostics.map(d => {
          const sev = ['', '错误', '警告', '信息', '提示'][d.severity || 0] || '未知';
          const pos = `L${d.range.start.line}:${d.range.start.character}`;
          return `  ${sev === '错误' ? '❌' : sev === '警告' ? '⚠️' : 'ℹ️'} [${pos}] ${sev}: ${d.message}`;
        });
        return { success: true, output: `诊断结果 (${result.diagnostics.length} 条):\n${lines.join('\n')}` };
      } catch (e: any) {
        return { success: false, error: String(e) };
      }
    },
  });

  ctx.tools.set('lsp_go_to_definition', {
    name: 'lsp_go_to_definition',
    description: '跳转到符号定义的位置',
    parameters: {
      file: '当前文件路径 (必填)',
      line: '行号 (从 0 开始)',
      character: '列号 (从 0 开始)',
    },
    execute: async (args): Promise<ToolResult> => {
      try {
        const file = String(args.file || '').trim();
        if (!file) return { success: false, error: 'file 必填' };
        const line = parseInt(String(args.line || '0'), 10);
        const character = parseInt(String(args.character || '0'), 10);

        const specs = await getSpecs();
        const spec = findLspForFile(file, specs);
        if (!spec) return { success: false, error: `未找到 ${file} 对应的 LSP 服务器` };

        const inst = await startLspServer(spec.language);
        if (!inst) return { success: false, error: `LSP ${spec.language} 启动失败` };

        const loc = await lspGoToDefinition(inst, file, line, character);
        if (!loc) return { success: true, output: '(未找到定义位置)' };
        return { success: true, output: `定义位置: ${loc.uri} (L${loc.range.start.line}:${loc.range.start.character})` };
      } catch (e: any) {
        return { success: false, error: String(e) };
      }
    },
  });

  ctx.tools.set('lsp_stop', {
    name: 'lsp_stop',
    description: '关闭指定语言的语言服务器 (或 all 关闭所有)',
    parameters: { language: '语言 id, 如 typescript, 或 all 关闭全部' },
    execute: async (args): Promise<ToolResult> => {
      try {
        const language = String(args.language || '').trim().toLowerCase();
        if (!language) return { success: false, error: 'language 必填 (或 "all")' };
        if (language === 'all') {
          stopAllLspServers();
          return { success: true, output: '✅ 所有 LSP 服务器已关闭' };
        }
        await stopLspServer(language);
        return { success: true, output: `✅ ${language} LSP 服务器已关闭` };
      } catch (e: any) {
        return { success: false, error: String(e) };
      }
    },
  });
}
