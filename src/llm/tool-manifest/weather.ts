import type { ToolManifest } from './types.js';

export const weather_fetch: ToolManifest = {
  id: 'weather_fetch',
  name: 'weather_fetch',
  oneLine: '显示天气信息 (用用户家庭位置确定温度单位).',
  description: '使用用户的家庭位置来确定温度单位: 美国用户使用华氏度, 其他用户使用摄氏度.',
  whenToUse: [
    '用户询问特定地点的天气',
    '用户询问"我该带雨伞/外套吗"',
    '用户在规划户外活动',
    '用户询问"[城市]怎么样"(天气语境)',
  ],
  whenNotToUse: [
    '气候或历史天气问题',
    '闲聊天气但未指定地点',
  ],
  parameters: [
    { name: 'location_name', type: 'string', required: true, description: '人类可读地点名' },
    { name: 'latitude', type: 'number', required: true, description: '纬度' },
    { name: 'longitude', type: 'number', required: true, description: '经度' },
  ],
  callExample: `[TOOL:weather_fetch]
[P:location_name]San Francisco, CA
[P:latitude]37.78
[P:longitude]-122.41
[ENDTOOL]`,
  layerId: 'tool.manifest',
};
