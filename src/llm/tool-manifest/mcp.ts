import type { ToolManifest } from './types.js';

export const search_mcp_registry: ToolManifest = {
  id: 'search_mcp_registry',
  name: 'search_mcp_registry',
  oneLine: '在 MCP 注册表中搜索可用连接器.',
  description: '当连接新的 MCP 可能有助于解决用户查询时, 无论他们是否指名了特定产品, 请调用此工具. 如果结果相关, 调用 suggest_connectors 呈现选项. 如果没有任何匹配任务的内容, 不要调用 suggest_connectors.',
  whenToUse: [
    '用户隐含读取个人数据 (邮件、日历、任务、文件、工单)',
    '需要连接外部服务 (Asana/Jira/Slack/Calendar)',
    '用户指名了特定连接器 (即使未连接)',
  ],
  whenNotToUse: [
    '知识问答/购物建议/一般性建议',
    '用户已指名了已连接的特定服务 (直接用)',
  ],
  parameters: [
    { name: 'keywords', type: 'array', required: true, description: '搜索关键词', items: { name: 'kw', type: 'string', required: true, description: '关键词' } },
  ],
  callExample: `[TOOL:search_mcp_registry]
[P:keywords]${'${'}JSON.stringify(["calendar","schedule"])[ENDTOOL]`,
  layerId: 'tool.mcp_apps',
};

export const suggest_connectors: ToolManifest = {
  id: 'suggest_connectors',
  name: 'suggest_connectors',
  oneLine: '向用户展示连接器选项, 让用户选择.',
  description: '每个选项都会渲染一个连接或使用按钮, 以及一个"以上都不是"选项. 调用后用一句简短的引导语结束你的回合.',
  whenToUse: [
    'search_mcp_registry 找到了相关选项',
    '用户未明确指名连接器',
    '工具调用因身份验证/凭据错误失败 (重认证)',
  ],
  whenNotToUse: [
    'search_mcp_registry 未返回相关内容',
    '用户已指名了特定的已连接服务 (直接用)',
    '没有 search_mcp_registry 上下文',
  ],
  parameters: [
    { name: 'uuids', type: 'array', required: true, description: '从 search_mcp_registry 结果的 directoryUuid 复制', items: { name: 'u', type: 'string', required: true, description: 'uuid' } },
  ],
  callExample: `[TOOL:suggest_connectors]
[P:uuids]${'${'}JSON.stringify(["uuid-from-search-result"])[ENDTOOL]`,
  layerId: 'tool.mcp_apps',
};
