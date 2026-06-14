/**
 * strip-hibsml.ts — 把 hibsml 协议标签转成 bolloon 标记
 *
 * hibsml 是 hibs 的协议: {hibsml:cite} {hibsml:invoke} {hibsml:thinking_mode}
 * bolloon 不解析这些, 但传给 LLM 之前要"金脱除":
 *   - cite → [CITE:index]
 *   - invoke → 简化
 *   - thinking_mode → 注释形式保留
 *   - 其他标签 → 整段脱除
 *
 * 不脱除 hibsml 标签会让 LLM 看到原文标记 (raw XML) 误以为是工具调用.
 */
const HIBML_REPLACEMENTS: [RegExp, string | ((m: string, ...g: string[]) => string)][] = [
  // {hibsml:cite index="0-1,3-5"}...{/hibsml:cite} → [CITE:0-1,3-5] ... [ENDCITE]
  [
    /\{hibsml:cite\s+index="([^"]+)"\}/g,
    (_m, idx) => `[CITE:${idx}]`,
  ],
  [/\{\/hibsml:cite\}/g, '[ENDCITE]'],
  // {hibsml:invoke name="X"} ... {/hibsml:invoke} → [TOOL:X] ... [ENDTOOL]
  [
    /\{hibsml:invoke\s+name="([^"]+)"\}/g,
    (_m, name) => `[TOOL:${name}]`,
  ],
  [/\{\/hibsml:invoke\}/g, '[ENDTOOL]'],
  // {hibsml:parameter name="X"}val{/hibsml:parameter} → [P:X]val[/P]
  [
    /\{hibsml:parameter\s+name="([^"]+)"\}/g,
    (_m, name) => `[P:${name}]`,
  ],
  [/\{\/hibsml:parameter\}/g, '[/P]'],
  // {hibsml:thinking_mode}auto{/hibsml:thinking_mode} → [THINKING:auto] (保留)
  [
    /\{hibsml:thinking_mode\}(\w+)\{\/hibsml:thinking_mode\}/g,
    (_m, mode) => `[THINKING:${mode}]`,
  ],
  // 脱除 voice_note (hibs 1 明确说永远不用)
  [/<details><summary>.*?<\/summary>.*?<\/details>/gs, ''],
  // 任何其他 hibsml:* 标签
  [/\{hibsml:[a-z_]+\}/g, ''],
  [/\{\/hibsml:[a-z_]+\}/g, ''],
];

export function stripHibsml(text: string): string {
  let out = text;
  for (const [re, rep] of HIBML_REPLACEMENTS) {
    out = out.replace(re, rep as any);
  }
  // 收尾: 多个空行合并
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}
