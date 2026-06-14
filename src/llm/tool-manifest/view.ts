import type { ToolManifest } from './types.js';

export const view: ToolManifest = {
  id: 'view',
  name: 'view',
  oneLine: '查看文本、图像和目录列表.',
  description: '支持的路径类型: 目录 (列出文件和目录, 最多 2 层深度, 忽略隐藏项和 node_modules); 图像文件 (.jpg, .jpeg, .png, .gif, .webp) 以可视方式显示; 文本文件显示带行号的内容 (前缀仅用于显示 — 不要在 str_replace 的 old_str 中包含它). 可以指定 view_range 来查看特定行.',
  whenToUse: [
    '读取已有文件的内容',
    '看图像文件',
    '列目录',
  ],
  whenNotToUse: [
    '创建新文件 (用 create_file)',
  ],
  parameters: [
    { name: 'description', type: 'string', required: true, description: '为什么我要查看' },
    { name: 'path', type: 'string', required: true, description: '绝对路径' },
    { name: 'view_range', type: 'array', required: false, description: '[start, end] 1-indexed, end=-1 表示到末尾', minItems: 2, maxItems: 2, items: { name: 'r', type: 'integer', required: true, description: '行号' } }
  ],
  callExample: `[TOOL:view]
[P:description]读 README
[P:path]/home/bolloon/README.md
[ENDTOOL]`,
  layerId: 'tool.manifest',
};
