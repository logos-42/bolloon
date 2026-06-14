import type { ToolManifest } from './types.js';

export const recommend_bolloon_apps: ToolManifest = {
  id: 'recommend_bolloon_apps',
  name: 'recommend_bolloon_apps',
  oneLine: '推荐 1-3 个 Bolloon 应用或扩展.',
  description: '当用户正在处理的事情可能更适合用 Bolloon 聊天以外的应用来完成时, 展示此建议. 仅推荐与用户当前用例相关的应用, 并按相关性排序.',
  whenToUse: [
    '编码任务 (Bolloon Code)',
    '知识工作 (Cowork)',
    '处理电子表格 (Excel) 或幻灯片 (PowerPoint)',
    '浏览器自动化 (Chrome)',
  ],
  whenNotToUse: [
    '用户已明确不想离开对话',
    '没有相关应用',
  ],
  parameters: [
    { name: 'app_ids', type: 'array', required: true, description: '应用 ID 数组', items: {
      name: 'id', type: 'string', required: true, description: '应用 ID (如 desktop/ios/android/code_terminal/code_vscode/code_jetbrains/code_slack/excel/powerpoint/chrome)',
    } },
  ],
  callExample: '[TOOL:recommend_bolloon_apps] [P:app_ids] ["code_vscode","excel"] [ENDTOOL]',
  layerId: 'tool.manifest',
};
