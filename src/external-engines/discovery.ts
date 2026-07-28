/**
 * external-engines/discovery.ts — 自动发现本机已安装的外部编码智能体
 *
 * 设计原则:
 *   - 纯函数 + 可注入 deps, 便于单测 (不真实碰 fs / 不真实 spawn)
 *   - best-effort: 不同工具版本配置文件 schema 会变, 用一个宽松的 key 提取器
 *   - 发现 ≠ 启用: 这里只回报"装了没 / 配了没", 真正写进 provider 由 import 负责
 *
 * 复用现有范式: 参照 src/pi-ecosystem-mcp/index.ts 的 discoverMcpServers()
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { spawn } from 'child_process';
import type { ModelProvider } from '../llm/config-store.js';
import type { DiscoveredEngine, EngineId, ProviderImportPatch } from './types.js';

/**
 * 检测依赖 (可注入, 单测时传 fake). 默认用真实实现.
 */
export interface DiscoveryDeps {
  /** 解析二进制路径, 找不到返回 undefined */
  which: (name: string) => Promise<string | undefined>;
  /** 读文件内容, 不存在/解析失败返回 undefined */
  readFile: (p: string) => Promise<string | undefined>;
  /** 列目录, 不存在返回 undefined */
  readdir: (dir: string) => Promise<string[] | undefined>;
  /** 环境变量快照 */
  env: Record<string, string | undefined>;
  /** HOME 目录 */
  home: string;
}

// ====================== 引擎规格表 ======================

interface EngineSpec {
  id: EngineId;
  displayName: string;
  /** 候选 CLI 名 (按优先级) */
  binaries: string[];
  /** 候选配置文件 (绝对或相对 home) */
  configFiles: string[];
  /** 可能持有 apiKey 的环境变量名 */
  envKeys: string[];
  /** 默认映射到的 Bolloon provider (配置里若声明了别的 provider 则覆盖) */
  providerHint: ModelProvider;
  /** 默认 baseUrl (配置/环境变量没给时用) */
  baseUrlHint?: string;
  /** 默认 model */
  modelHint?: string;
  /** 该引擎可用的模型候选列表 (API 配置 UI 的模型筛选下拉用) */
  models?: string[];
  /** 委派时指定模型用的 flag (如 opencode/claude-code 用 -m / --model); 不填则不支持 model 覆盖 */
  modelFlag?: string;
  /** 委派时把 prompt 拼成 argv 的模板 (best-effort, 各版本 flag 可能不同) */
  delegateArgs: (prompt: string) => string[];
}

/**
 * 可筛选的模型候选列表.
 * OpenCode / OpenClaw / Hermes 是 provider 无关 (openai 兼容 + anthropic 等),
 * 给一份跨供应商的宽列表便于在 UI 里筛选; Codex / Claude Code 给各自供应商的列表.
 * 实验 API 由声明文件决定, 不预置.
 */
const OPENAI_COMPAT_MODELS = [
  'gpt-5.5', 'gpt-5', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo',
  'deepseek-v4-flash', 'deepseek-v4-pro',
  'qwen-plus', 'qwen-max', 'qwen-turbo',
  'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k',
  'glm-4-flash', 'glm-4', 'glm-4-plus',
  'mimo-v2.5-pro', 'mimo-v2-pro',
];
const ANTHROPIC_MODELS = [
  'claude-sonnet-4-5-20250929', 'claude-opus-4', 'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022', 'claude-3-opus-20240229',
];
const GEMINI_MODELS = ['gemini-3.5-flash', 'gemini-2.5-pro', 'gemini-3.1-flash-lite', 'gemini-flash-latest'];
const OPENROUTER_MODELS = [
  'anthropic/claude-sonnet-4.5', 'anthropic/claude-3.5-sonnet', 'openai/gpt-4.1',
  'deepseek/deepseek-v4-flash', 'google/gemini-2.5-pro',
];
/** OpenCode 是 provider 无关, 合并主流供应商列表 */
const OPENCODE_MODELS = [
  ...OPENAI_COMPAT_MODELS,
  ...ANTHROPIC_MODELS,
  ...GEMINI_MODELS,
  ...OPENROUTER_MODELS,
];

/** provider 别名 → Bolloon ModelProvider */
const PROVIDER_ALIASES: Record<string, ModelProvider> = {
  openai: 'openai',
  'openai-compatible': 'openai',
  azure: 'openai',
  anthropic: 'anthropic',
  claude: 'anthropic',
  ollama: 'ollama',
  openrouter: 'openrouter',
  gemini: 'gemini',
  google: 'gemini',
  minimax: 'minimax',
  deepseek: 'deepseek',
  kimi: 'kimi',
  moonshot: 'kimi',
  glm: 'glm',
  zhipu: 'glm',
  qwen: 'qwen',
  dashscope: 'qwen',
  mimo: 'mimo',
  xiaomi: 'mimo',
  local: 'local',
};

/** 已知引擎规格 (不含 experiment, experiment 由目录扫描动态产出) */
const KNOWN_ENGINES: EngineSpec[] = [
  {
    id: 'codex',
    displayName: 'OpenAI Codex CLI',
    binaries: ['codex'],
    configFiles: ['.codex/config.json', '.codex/auth.json'],
    envKeys: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    providerHint: 'openai',
    baseUrlHint: 'https://api.openai.com/v1',
    modelHint: 'gpt-4.1',
    models: OPENAI_COMPAT_MODELS,
    modelFlag: '-m',
    delegateArgs: (p) => ['exec', '--full-auto', p],
  },
  {
    id: 'claude-code',
    displayName: 'Claude Code (Anthropic)',
    binaries: ['claude', 'claude-code'],
    configFiles: ['.claude.json', '.config/claude/config.json'],
    envKeys: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
    providerHint: 'anthropic',
    baseUrlHint: 'https://api.anthropic.com/v1',
    modelHint: 'claude-sonnet-4-5-20250929',
    models: ANTHROPIC_MODELS,
    modelFlag: '--model',
    delegateArgs: (p) => ['-p', p, '--print'],
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    binaries: ['opencode'],
    configFiles: ['.config/opencode/opencode.json', '.opencode/opencode.json', 'opencode.json'],
    envKeys: ['OPENCODE_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY'],
    providerHint: 'openai',
    models: OPENCODE_MODELS,
    modelFlag: '-m',
    // opencode run 默认进 TUI 不退出, --format json 强制 headless 输出并退出 (非交互委派必需)
    delegateArgs: (p) => ['run', p, '--format', 'json'],
  },
  {
    id: 'openclaw',
    displayName: 'OpenClaw',
    binaries: ['openclaw', 'open-claw'],
    configFiles: ['.openclaw/config.json', '.config/openclaw/config.json'],
    envKeys: ['OPENCLAW_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
    providerHint: 'openai',
    models: OPENCODE_MODELS,
    delegateArgs: (p) => ['run', p],
  },
  {
    id: 'hermes',
    displayName: 'Hermes',
    binaries: ['hermes'],
    configFiles: ['.hermes/config.json', '.config/hermes/config.json'],
    envKeys: ['HERMES_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
    providerHint: 'openai',
    models: OPENCODE_MODELS,
    delegateArgs: (p) => ['prompt', p],
  },
  {
    id: 'opencli',
    displayName: 'OpenCLI',
    binaries: ['opencli', 'open-cli'],
    configFiles: ['.opencli/config.json', '.config/opencli/config.json'],
    envKeys: ['OPENCLI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
    providerHint: 'openai',
    models: OPENCODE_MODELS,
    modelFlag: '-m',
    delegateArgs: (p) => ['exec', p],
  },
];

// ====================== 默认 deps (真实 IO) ======================

function realWhichImpl(name: string): Promise<string | undefined> {
  // 用 command -v 解析 PATH; JSON.stringify 防止名字里的元字符注入内层 shell
  return new Promise((resolve) => {
    const p = spawn('sh', ['-c', `command -v ${JSON.stringify(name)}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    p.on('close', () => resolve(out.trim() || undefined));
    p.on('error', () => resolve(undefined));
  });
}

function realReadFileImpl(p: string): Promise<string | undefined> {
  return fs.readFile(p, 'utf-8').then((c) => c).catch(() => undefined);
}

function realReaddirImpl(dir: string): Promise<string[] | undefined> {
  return fs.readdir(dir).then((c) => c).catch(() => undefined);
}

export function defaultDeps(): DiscoveryDeps {
  return {
    which: realWhichImpl,
    readFile: realReadFileImpl,
    readdir: realReaddirImpl,
    env: process.env as Record<string, string | undefined>,
    home: process.env.HOME || process.env.USERPROFILE || '/tmp',
  };
}

// ====================== 纯工具函数 (可单测) ======================

const APIKEY_KEYS = ['apiKey', 'api_key', 'apikey', 'key', 'token', 'access_token', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OPENCLAW_API_KEY', 'HERMES_API_KEY', 'CODEX_API_KEY', 'OPENCODE_API_KEY'];
const BASEURL_KEYS = ['baseUrl', 'base_url', 'apiBase', 'api_base', 'endpoint', 'baseURL', 'API_BASE'];
const MODEL_KEYS = ['model', 'modelName', 'model_name'];
const PROVIDER_KEYS = ['provider', 'providerName', 'provider_name'];

/** 宽松提取: 先看顶层, 再看一层嵌套 (常见的 providers.xxx / auth.xxx) */
function pickKey(obj: any, keys: string[]): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  for (const k of Object.keys(obj)) {
    const sub = obj[k];
    if (sub && typeof sub === 'object') {
      for (const kk of keys) {
        const v = sub[kk];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
    }
  }
  return undefined;
}

/** 把任意 provider 字符串解析成 Bolloon ModelProvider (未知 → 兜底 hint) */
export function resolveProvider(raw: string | undefined, hint: ModelProvider): ModelProvider {
  if (!raw) return hint;
  const norm = raw.trim().toLowerCase();
  if ((PROVIDER_ALIASES as Record<string, ModelProvider>)[norm]) {
    return (PROVIDER_ALIASES as Record<string, ModelProvider>)[norm];
  }
  // 容错: 包含关键字也识别
  if (norm.includes('anthropic') || norm.includes('claude')) return 'anthropic';
  if (norm.includes('openai')) return 'openai';
  if (norm.includes('gemini') || norm.includes('google')) return 'gemini';
  if (norm.includes('ollama')) return 'ollama';
  if (norm.includes('deepseek')) return 'deepseek';
  if (norm.includes('minimax')) return 'minimax';
  if (norm.includes('openrouter')) return 'openrouter';
  return hint;
}

/** 把发现到的引擎映射成 provider 导入 patch (纯函数, 可单测) */
export function mapEngineToProviderConfig(engine: DiscoveredEngine): ProviderImportPatch {
  if (!engine.provider) {
    throw new Error(`引擎 ${engine.id} 没有可映射的 provider, 无法导入为供应商`);
  }
  const patch: ProviderImportPatch['patch'] = { enabled: true };
  if (engine.apiKey) patch.apiKey = engine.apiKey;
  if (engine.baseUrl) patch.baseUrl = engine.baseUrl;
  if (engine.model) patch.model = engine.model;
  return { provider: engine.provider, patch };
}

/** 解析单个实验 API 文件内容 → 一组 {name, provider, apiKey, baseUrl, model, models?} */
export function parseExperimentFile(content: string): Array<{
  name: string;
  provider?: ModelProvider;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  models?: string[];
}> {
  let json: any;
  try {
    json = JSON.parse(content);
  } catch {
    return [];
  }
  const out: Array<{ name: string; provider?: ModelProvider; apiKey?: string; baseUrl?: string; model?: string; models?: string[] }> = [];

  const pushOne = (obj: any, fallbackName: string) => {
    if (!obj || typeof obj !== 'object') return;
    const provider = resolveProvider(pickKey(obj, PROVIDER_KEYS), 'openai');
    const apiKey = pickKey(obj, APIKEY_KEYS);
    const baseUrl = pickKey(obj, BASEURL_KEYS);
    const model = pickKey(obj, MODEL_KEYS);
    const models = Array.isArray(obj.models) ? obj.models.filter((m: any) => typeof m === 'string' && m.trim()) : undefined;
    if (!apiKey && !baseUrl) return; // 没任何连接信息, 跳过
    out.push({
      name: typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : fallbackName,
      provider,
      apiKey,
      baseUrl,
      model,
      models,
    });
  };

  // 形态 1: 顶层直接是 { name, provider, apiKey, baseUrl, model }
  if (json.name || json.provider || json.apiKey || json.baseUrl) {
    pushOne(json, 'experiment');
    return out;
  }
  // 形态 2: { providers: [...] } / { engines: [...] } / { apis: [...] }
  for (const arrKey of ['providers', 'engines', 'apis', 'experiments']) {
    if (Array.isArray(json[arrKey])) {
      json[arrKey].forEach((e: any, i: number) => pushOne(e, `experiment-${arrKey}-${i}`));
      return out;
    }
  }
  return out;
}

// ====================== 核心发现逻辑 ======================

async function discoverOne(spec: EngineSpec, deps: DiscoveryDeps): Promise<DiscoveredEngine> {
  // 1. CLI 是否安装
  let cliPath: string | undefined;
  for (const bin of spec.binaries) {
    const found = await deps.which(bin);
    if (found) {
      cliPath = found;
      break;
    }
  }

  // 2. 读配置文件
  let configObj: any = null;
  let configPath: string | undefined;
  for (const cf of spec.configFiles) {
    const abs = path.isAbsolute(cf) ? cf : path.join(deps.home, cf);
    const content = await deps.readFile(abs);
    if (content) {
      try {
        configObj = JSON.parse(content);
        configPath = abs;
        break;
      } catch {
        // 非 JSON, 跳过
      }
    }
  }

  // 3. 解析 apiKey: 环境变量优先, 其次配置文件
  let apiKey: string | undefined;
  let source: DiscoveredEngine['source'] = 'none';
  for (const ek of spec.envKeys) {
    const v = deps.env[ek];
    if (v && v.trim()) {
      apiKey = v.trim();
      source = 'env';
      break;
    }
  }
  if (!apiKey) {
    const fromConfig = pickKey(configObj, APIKEY_KEYS);
    if (fromConfig) {
      apiKey = fromConfig;
      source = 'config';
    }
  }

  // 4. baseUrl / model: 配置文件优先, 其次 hint
  const baseUrl = pickKey(configObj, BASEURL_KEYS) || spec.baseUrlHint;
  const model = pickKey(configObj, MODEL_KEYS) || spec.modelHint;

  // 4.1 模型候选列表: 配置文件声明的 models 数组优先, 否则用规格预置列表
  let models = spec.models;
  if (configObj && Array.isArray(configObj.models) && configObj.models.length > 0) {
    models = configObj.models.filter((m: any) => typeof m === 'string' && m.trim());
  }

  // 5. provider: 配置文件声明的 > hint
  const provider = resolveProvider(pickKey(configObj, PROVIDER_KEYS), spec.providerHint);

  const configured = !!apiKey || provider === 'ollama' || provider === 'local';
  const available = !!cliPath && configured;

  return {
    id: spec.id,
    displayName: spec.displayName,
    installed: !!cliPath,
    configured,
    available,
    cliPath,
    configPath,
    provider,
    apiKey,
    baseUrl,
    model,
    models,
    source,
    notes: `委派参数模板: ${spec.binaries[0]} ${spec.delegateArgs('<prompt>').join(' ')}`,
  };
}

async function discoverExperimentEngines(deps: DiscoveryDeps): Promise<DiscoveredEngine[]> {
  const dir =
    deps.env['BOLLOON_EXPERIMENT_API_DIR'] ||
    path.join(deps.home, '.bolloon', 'experiments');
  const files = await deps.readdir(dir);
  if (!files || files.length === 0) return [];

  const result: DiscoveredEngine[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const content = await deps.readFile(path.join(dir, f));
    if (!content) continue;
    const parsed = parseExperimentFile(content);
    for (const item of parsed) {
      const provider = item.provider || 'openai';
      result.push({
        id: `experiment:${item.name}`,
        displayName: `实验 API: ${item.name}`,
        installed: true, // 实验 API 视为"已装" (它们就是配置文件声明的)
        configured: !!(item.apiKey || item.baseUrl),
        available: !!(item.apiKey || item.baseUrl),
        configPath: path.join(dir, f),
        provider,
        apiKey: item.apiKey,
        baseUrl: item.baseUrl,
        model: item.model,
        models: item.models,
        source: 'config',
        notes: '来自实验目录声明的 API (BOLLOON_EXPERIMENT_API_DIR)',
      });
    }
  }
  return result;
}

/** 发现所有外部引擎 (已知 + 实验) */
export async function discoverEngines(deps: DiscoveryDeps = defaultDeps()): Promise<DiscoveredEngine[]> {
  const known = await Promise.all(KNOWN_ENGINES.map((spec) => discoverOne(spec, deps)));
  const experiment = await discoverExperimentEngines(deps);
  return [...known, ...experiment];
}

/** 取单个引擎规格 (委派时用) */
export function getEngineSpec(id: EngineId): EngineSpec | undefined {
  return KNOWN_ENGINES.find((e) => e.id === id);
}

/** 取已知引擎的委派 argv (best-effort); 传 model 时追加该引擎的 modelFlag */
export function buildDelegateArgs(id: EngineId, prompt: string, model?: string): string[] | undefined {
  const spec = getEngineSpec(id);
  if (!spec) return undefined;
  const args = spec.delegateArgs(prompt);
  if (model && spec.modelFlag) {
    args.push(spec.modelFlag, model);
  }
  return args;
}
