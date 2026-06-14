import type { ToolManifest } from './types.js';

export const web_search: ToolManifest = {
  id: 'web_search',
  name: 'web_search',
  oneLine: '搜索 Web (返回前 10 条结果).',
  description: '当需要当前信息或信息可能自知识截止以来已发生变化时使用. 1-6 词查询最佳. 默认改写; 引用应是个罕见的例外.',
  whenToUse: [
    '当前状态 (谁担任某职位、什么政策生效)',
    '时效性信息 (股价、新闻)',
    '不识别的实体 (默认搜索)',
  ],
  whenNotToUse: [
    '永恒信息/成熟技术事实 (直接答)',
    '已故人物 (不会变)',
  ],
  parameters: [
    { name: 'query', type: 'string', required: true, description: '搜索查询 (1-6 词最佳)' },
  ],
  callExample: `[TOOL:web_search]
[P:query]S&P 500 current price
[ENDTOOL]`,
  layerId: 'tool.web_search',
};

export const web_fetch: ToolManifest = {
  id: 'web_fetch',
  name: 'web_fetch',
  oneLine: '获取指定 URL 网页的内容.',
  description: '此函数只能获取用户直接提供的或由 web_search 和 web_fetch 工具的结果中返回的 EXACT URL. 此工具无法访问需要身份验证的内容, 例如私有 Google Docs 或登录墙后的页面. URL 必须包含协议.',
  whenToUse: [
    'web_search 摘要不够, 需要读完整文章',
    '用户提供 URL 让你读',
  ],
  whenNotToUse: [
    '需要身份验证的页面',
    'web_search 已经足够时',
  ],
  parameters: [
    { name: 'url', type: 'string', required: true, description: '完整 URL (含协议, https://...)', format: 'uri' },
    { name: 'allowed_domains', type: 'array', required: false, description: '仅允许的域名白名单 (如 ["example.com","*.github.com"])', items: { name: 'd', type: 'string', required: true, description: '域名' } },
    { name: 'blocked_domains', type: 'array', required: false, description: '黑名单域名', items: { name: 'd', type: 'string', required: true, description: '域名' } },
    { name: 'html_extraction_method', type: 'string', required: false, description: 'HTML 提取方法 (e.g. "text"/"markdown")' },
    { name: 'is_zdr', type: 'boolean', required: false, description: '是否 Zero Data Retention 请求 (true 时不记录 URL)' },
    { name: 'text_content_token_limit', type: 'integer', required: false, description: 'token 限制', minimum: 0 },
    { name: 'web_fetch_pdf_extract_text', type: 'boolean', required: false, description: '是否提取 PDF 文本' },
    { name: 'web_fetch_rate_limit_key', type: 'string', required: false, description: '速率限制键' },
    { name: 'web_fetch_rate_limit_dark_launch', type: 'boolean', required: false, description: '速率限制暗启动模式' },
  ],
  callExample: `[TOOL:web_fetch]
[P:url]https://example.com/article
[ENDTOOL]`,
  layerId: 'tool.manifest',
};
