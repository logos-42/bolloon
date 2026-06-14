import type { ToolManifest } from './types.js';

export const recipe_display_v0: ToolManifest = {
  id: 'recipe_display_v0',
  name: 'recipe_display_v0',
  oneLine: '显示带可调整份量的交互式食谱.',
  description: '用户要求食谱、烹饪说明或食物准备指南时使用. 该组件允许用户通过调整份量控件按比例缩放所有食材的用量.',
  whenToUse: [
    '用户问食谱',
    '需要比例缩放 (份量调整)',
  ],
  whenNotToUse: [
    '用户只要食材列表 (用文字)',
    '用户问餐厅推荐 (用 places_search)',
  ],
  parameters: [
    { name: 'title', type: 'string', required: true, description: '食谱名称' },
    { name: 'base_servings', type: 'integer', required: false, description: '基础份数 (默认 4)' },
    { name: 'description', type: 'string', required: false, description: '简短描述' },
    { name: 'ingredients', type: 'array', required: true, description: '食材', items: {
      name: 'ing', type: 'object', required: true, description: '食材', properties: [
        { name: 'id', type: 'string', required: true, description: '唯一 ID' },
        { name: 'amount', type: 'number', required: true, description: '数量', minimum: 0 },
        { name: 'unit', type: 'enum', required: false, description: 'g/kg/ml/l/tsp/tbsp/cup/fl_oz/oz/lb/pinch', enumValues: ['g','kg','ml','l','tsp','tbsp','cup','fl_oz','oz','lb','pinch'] },
        { name: 'name', type: 'string', required: true, description: '显示名 (整体可数项, 把 counting noun 放在这里)' },
      ],
    } },
    { name: 'steps', type: 'array', required: true, description: '步骤', items: {
      name: 's', type: 'object', required: true, description: '步骤', properties: [
        { name: 'id', type: 'string', required: true, description: '唯一 ID' },
        { name: 'title', type: 'string', required: true, description: '步骤摘要' },
        { name: 'content', type: 'string', required: true, description: '完整指令 (用 {id} 引用食材)' },
        { name: 'timer_seconds', type: 'integer', required: false, description: '等待/烹饪计时秒数', minimum: 0 }
      ],
    } },
    { name: 'notes', type: 'string', required: false, description: '附加说明' },
  ],
  callExample: `[TOOL:recipe_display_v0]
[P:title]Pasta
[P:ingredients]${'${'}JSON.stringify([{"id":"a1","amount":500,"name":"pasta"}])[ENDTOOL]`,
  layerId: 'tool.manifest',
};
