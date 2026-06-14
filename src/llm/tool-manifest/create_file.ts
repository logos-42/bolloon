import type { ToolManifest } from './types.js';

export const create_file: ToolManifest = {
  id: 'create_file',
  name: 'create_file',
  oneLine: '在容器中创建带有内容的新文件.',
  description: '如果路径已存在则失败 — 使用 str_replace 编辑现有文件, 或使用 bash_tool (cat > path << EOF) 覆盖.',
  whenToUse: [
    '创建新文件',
    '需要写完整的文件内容',
  ],
  whenNotToUse: [
    '编辑已有文件 (用 str_replace)',
  ],
  parameters: [
    { name: 'description', type: 'string', required: true, description: '为什么我要创建此文件' },
    { name: 'file_text', type: 'string', required: true, description: '要写入的文件内容' },
    { name: 'path', type: 'string', required: true, description: '要创建的文件路径' },
  ],
  callExample: `[TOOL:create_file]
[P:description]新建 README
[P:file_text]# Project\n\nHello world
[P:path]/home/bolloon/README.md
[ENDTOOL]`,
  layerId: 'tool.manifest',
};
