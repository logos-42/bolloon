import type { ToolManifest } from './types.js';

export const message_compose_v1: ToolManifest = {
  id: 'message_compose_v1',
  name: 'message_compose_v1',
  oneLine: '起草目标导向的消息 (email/textMessage/other).',
  description: '分析情境类型 (工作分歧、谈判、跟进、传达坏消息、请求某事、设定边界、道歉、拒绝、提供反馈、冷启动接触、回应反馈、澄清误解、委派、庆祝) 并识别竞争目标. 多种方法 (高风险/模糊) 生成 2-3 种策略.',
  whenToUse: [
    '用户要你起草一封邮件/消息',
    '高风险沟通 (谈判、道歉、设定边界)',
    '需要适配渠道 (邮件 vs Slack vs 短信)',
  ],
  whenNotToUse: [
    '用户只是要写笔记/便签',
    '对话中直接回复',
  ],
  parameters: [
    { name: 'kind', type: 'enum', required: true, description: 'email | textMessage | other', enumValues: ['email', 'textMessage', 'other'] },
    { name: 'summary_title', type: 'string', required: true, description: '消息的摘要标题' },
    { name: 'variants', type: 'array', required: true, description: '至少 1 个变体', items: {
      name: 'variant', type: 'object', required: true, description: '变体', properties: [
        { name: 'label', type: 'string', required: true, description: '变体标签' },
        { name: 'body', type: 'string', required: true, description: '消息内容' },
        { name: 'subject', type: 'string', required: false, description: '邮件主题 (仅 email)' },
      ],
    } },
  ],
  callExample: `[TOOL:message_compose_v1]
[P:kind]email
[P:summary_title]Follow-up on Q3 review
[P:variants]${'${'}JSON.stringify([{"label":"direct","subject":"Quick follow-up","body":"..."}])[ENDTOOL]`,
  layerId: 'tool.manifest',
};
