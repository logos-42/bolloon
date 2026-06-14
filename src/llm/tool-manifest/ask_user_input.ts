import type { ToolManifest } from './types.js';

export const ask_user_input_v0: ToolManifest = {
  id: 'ask_user_input_v0',
  name: 'ask_user_input_v0',
  oneLine: '在提供建议前展示可点击的选项以收集用户偏好 (移动端友好).',
  description: '此工具显示交互式按钮, 用户可以点击按钮来回答, 在移动端比键入要容易得多. 用于引出信息 (ELICITATION) — 当你需要了解用户的偏好、约束或目标以提供有用建议时.',
  whenToUse: [
    '需要了解用户的偏好/约束/目标以提供有用建议',
    '示例: 帮我制定锻炼计划 → 询问目标(力量/有氧/减重)、可用时间、设备访问',
    '示例: 帮我为朋友挑礼物 → 询问场合、预算、朋友的兴趣',
  ],
  whenNotToUse: [
    '用户问 A 还是 B (想要分析, 不是按钮)',
    '用户在发泄或处理情绪',
    '用户询问观点',
    '事实问题 (直接回答)',
    '用户需要散文形式反馈',
  ],
  parameters: [
    { name: 'questions', type: 'array', required: true, description: '1-3 个问题', items: {
      name: 'question', type: 'object', required: true, description: '单个问题', properties: [
        { name: 'question', type: 'string', required: true, description: '向用户显示的问题' },
        { name: 'type', type: 'enum', required: false, description: 'single_select | multi-select | rank_priorities', enumValues: ['single_select', 'multi_select', 'rank_priorities'] },
        { name: 'options', type: 'array', required: true, description: '2-4 个带短标签的选项', items: {
          name: 'option', type: 'object', required: true, description: '选项', properties: [
            { name: 'label', type: 'string', required: true, description: '短标签' },
            { name: 'description', type: 'string', required: false, description: '选项描述' },
          ],
        } },
      ],
    } },
  ],
  callExample: `[TOOL:ask_user_input_v0]
[P:questions]${'${'}JSON.stringify([{"question":"你的预算?","options":[{"label":"<500"},{"label":"500-2000"}]}])[ENDTOOL]`,
  layerId: 'tool.manifest',
};
