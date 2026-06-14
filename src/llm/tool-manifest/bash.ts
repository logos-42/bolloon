import type { ToolManifest } from './types.js';

export const bash_tool: ToolManifest = {
  id: 'bash_tool',
  name: 'bash_tool',
  oneLine: '在容器中运行 bash 命令.',
  description: '在容器中运行 bash 命令. 必须用 description 参数说明为什么跑.',
  whenToUse: [
    '需要执行 shell 命令 (ls, mkdir, npm, git 等)',
    '需要跑构建/测试/脚本',
  ],
  whenNotToUse: [
    '读取文件 (用 view)',
    '编辑文件 (用 str_replace 或 create_file)',
  ],
  parameters: [
    { name: 'command', type: 'string', required: true, description: '要运行的 bash 命令' },
    { name: 'description', type: 'string', required: true, description: '为什么我要运行此命令' },
  ],
  callExample: `[TOOL:bash_tool]
[P:command]ls -la /tmp
[P:description]列出 /tmp 目录内容
[ENDTOOL]`,
  layerId: 'tool.bash',
};
