import type { ToolManifest } from './types.js';

export const image_search: ToolManifest = {
  id: 'image_search',
  name: 'image_search',
  oneLine: '在 Web 上查找图像并连同尺寸返回 (3-4 张/次).',
  description: '对于视觉内容可增强用户理解的任何查询, 默认使用图像搜索. 当交付物主要是文本时跳过.',
  whenToUse: [
    '地点、动物、食物、人物、产品、风格、图表、历史照片、练习',
    '关于视觉事物的简单事实 ("埃菲尔铁塔是哪一年造的?" → 展示它)',
    '多项目内容 (指南、列表、比较、时间线、步骤) — 交错图像',
  ],
  whenNotToUse: [
    '文本输出 (撰写邮件、代码、文章)',
    '数字/数据、编码查询、技术支持、分步说明',
    '关于非视觉主题的分析',
  ],
  parameters: [
    { name: 'max_results', type: 'integer', required: false, description: '返回图片数 (默认 3, 最少 3, 最多 5)' },
    { name: 'query', type: 'string', required: true, description: '搜索查询 (3-6 词具体)' },
  ],
  callExample: `[TOOL:image_search]
[P:query]Eiffel Tower Paris
[ENDTOOL]`,
  layerId: 'tool.image_search',
};
