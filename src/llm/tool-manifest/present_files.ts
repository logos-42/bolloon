import type { ToolManifest } from './types.js';

export const present_files: ToolManifest = {
  id: 'present_files',
  name: 'present_files',
  oneLine: '让文件对用户可见, 客户端界面中查看和渲染.',
  description: '接收来自容器文件系统的文件路径数组, 返回客户端可访问文件的输出路径. 输出路径按与输入路径相同的顺序返回. 多个文件可在单次调用中高效呈现. 如果文件不在输出目录中, 会自动复制到该目录.',
  whenToUse: [
    '让用户可以查看、下载或与文件交互',
    '一次展示多个相关文件',
    '创建了应向用户展示的文件之后',
  ],
  whenNotToUse: [
    '只是为了自己的处理而需要读取文件内容',
    '临时或中间文件',
  ],
  parameters: [
    { name: 'filepaths', type: 'array', required: true, description: '至少 1 个文件路径', items: { name: 'path', type: 'string', required: true, description: '容器内路径' } },
  ],
  callExample: `[TOOL:present_files]
[P:filepaths]${'${'}JSON.stringify(["/home/bolloon/report.md"])[ENDTOOL]`,
  layerId: 'tool.manifest',
};
