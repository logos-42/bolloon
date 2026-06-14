/**
 * tool-manifest/index.ts — 工具清单总入口
 *
 * 16 个工具的定义在 ./<tool>.ts 各文件 (1 个文件 1 个工具, 易于维护).
 * 这个文件提供:
 *   - listTools(): 返回所有 16 个
 *   - getToolManifest(id): 按 id 拿
 *   - formatForPrompt(): 把清单缩到 1-2KB 进 system prompt (远小于 24KB)
 *
 * 设计: prompt 只看到 oneLine + whenToUse + whenNotToUse + callExample (1-3 行).
 * 详细 schema (parameters 嵌套) 在代码侧 — bolloon 真实调用工具时由 PiAI 客户端读.
 */
import type { ToolManifest } from './types.js';

import { ask_user_input_v0 } from './ask_user_input.js';
import { bash_tool } from './bash.js';
import { create_file } from './create_file.js';
import { fetch_sports_data } from './fetch_sports_data.js';
import { image_search } from './image_search.js';
import { message_compose_v1 } from './message_compose.js';
import { places_search, places_map_display_v0 } from './places.js';
import { present_files } from './present_files.js';
import { recipe_display_v0 } from './recipe.js';
import { recommend_bolloon_apps } from './recommend_apps.js';
import { search_mcp_registry, suggest_connectors } from './mcp.js';
import { str_replace } from './str_replace.js';
import { view } from './view.js';
import { web_search, web_fetch } from './web.js';
import { weather_fetch } from './weather.js';

const ALL: ToolManifest[] = [
  ask_user_input_v0,
  bash_tool,
  create_file,
  fetch_sports_data,
  image_search,
  message_compose_v1,
  places_search,
  places_map_display_v0,
  present_files,
  recipe_display_v0,
  recommend_bolloon_apps,
  search_mcp_registry,
  suggest_connectors,
  str_replace,
  view,
  web_search,
  web_fetch,
  weather_fetch,
];

export function listTools(): ToolManifest[] {
  return ALL;
}

export function getToolManifest(id: string): ToolManifest | undefined {
  return ALL.find((t) => t.id === id);
}

export function getToolsByLayer(layerId: string): ToolManifest[] {
  return ALL.filter((t) => t.layerId === layerId);
}

/**
 * 缩到 1-3KB 装进 system prompt
 * 包含: 名字 + 一句话 + whenToUse(2) + whenNotToUse(1) + 1 行示例
 *
 * 不包含: 完整 parameters schema (那是 PiAI 客户端在调用时读)
 */
export function formatForPrompt(tools?: ToolManifest[]): string {
  const list = tools ?? ALL;
  const lines: string[] = [
    `## 工具清单 (${list.length} 个, 详细 schema 在 src/llm/tool-manifest/, 调用时由 PiAI 客户端解析)`,
    '',
  ];
  for (const t of list) {
    lines.push(`### ${t.id}`);
    lines.push(`- **用途**: ${t.oneLine}`);
    lines.push(`- **何时用**: ${t.whenToUse[0] ?? ''}`);
    if (t.whenToUse.length > 1) {
      lines.push(`  - 也: ${t.whenToUse.slice(1, 3).join(' / ')}`);
    }
    lines.push(`- **何时不用**: ${t.whenNotToUse[0] ?? ''}`);
    lines.push(`- **示例**: ${t.callExample.replace(/\n/g, ' ')}`);
    lines.push('');
  }
  return lines.join('\n');
}
