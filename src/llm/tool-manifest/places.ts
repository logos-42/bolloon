import type { ToolManifest } from './types.js';

export const places_search: ToolManifest = {
  id: 'places_search',
  name: 'places_search',
  oneLine: '使用 Google Places 搜索地点/商户/餐厅/景点 (多查询).',
  description: '单次调用支持多个查询. 多个查询可用于: 高效的行程规划, 拆解广泛或抽象的请求. 包含更广泛的区域以避免同名地点冲突.',
  whenToUse: [
    '用户问某地有什么 (餐厅/景点/酒店)',
    '行程规划 (多地点)',
    '需要 place_id 以便后续在地图展示',
  ],
  whenNotToUse: [
    '需要地点坐标 (问 GPS)',
    '只问天气 (用 weather_fetch)',
  ],
  parameters: [
    { name: 'queries', type: 'array', required: true, description: '1-10 个查询', minItems: 1, maxItems: 10, items: {
      name: 'q', type: 'object', required: true, description: '单查询', properties: [
        { name: 'query', type: 'string', required: true, description: '自然语言搜索' },
        { name: 'max_results', type: 'integer', required: false, description: '1-10, 默认 5', minimum: 1, maximum: 10, default: 5 }
      ],
    } },
    { name: 'location_bias_lat', type: 'number', required: false, description: '可选纬度' },
    { name: 'location_bias_lng', type: 'number', required: false, description: '可选经度' },
    { name: 'location_bias_radius', type: 'number', required: false, description: '米 (默认 5000)', default: 5000 }
  ],
  callExample: `[TOOL:places_search]
[P:queries]${'${'}JSON.stringify([{"query":"ramen restaurants Tokyo"}])[ENDTOOL]`,
  layerId: 'tool.manifest',
};

export const places_map_display_v0: ToolManifest = {
  id: 'places_map_display_v0',
  name: 'places_map_display_v0',
  oneLine: '在地图上展示地点, 附上你的推荐和内行小贴士.',
  description: '工作流: 先用 places_search 获取 place_id, 然后用 place_id 引用调用本工具. 两种模式: 简单标记 (locations) 或行程 (days).',
  whenToUse: [
    '用户需要看地点在地图上',
    '行程规划, 需要可视化',
  ],
  whenNotToUse: [
    '只问地点信息 (用 places_search 文字回答)',
  ],
  parameters: [
    { name: 'locations', type: 'array', required: false, description: '简单标记模式', minItems: 1, maxItems: 50, items: {
      name: 'loc', type: 'object', required: true, description: '地点', properties: [
        { name: 'name', type: 'string', required: true, description: '地点名' },
        { name: 'latitude', type: 'number', required: true, description: '纬度' },
        { name: 'longitude', type: 'number', required: true, description: '经度' },
        { name: 'place_id', type: 'string', required: false, description: '从 places_search 复制' },
        { name: 'notes', type: 'string', required: false, description: '你的小贴士' },
        { name: 'address', type: 'string', required: false, description: '自定义地点的地址 (没有 place_id 时用)' },
        { name: 'arrival_time', type: 'string', required: false, description: '到达时间 (用于行程, e.g. "8:00 AM")' },
        { name: 'duration_minutes', type: 'integer', required: false, description: '停留时长 (分钟)' },
      ],
    } },
    { name: 'days', type: 'array', required: false, description: '行程模式', minItems: 1, maxItems: 30, items: {
      name: 'day', type: 'object', required: true, description: '单日', properties: [
        { name: 'day_number', type: 'integer', required: true, description: '天数 (从 1 开始)', minimum: 1 },
        { name: 'title', type: 'string', required: false, description: '日期标题' },
        { name: 'narrative', type: 'string', required: false, description: '该日叙述' },
        { name: 'locations', type: 'array', required: true, description: '该日地点', minItems: 1, maxItems: 50, items: {
          name: 'loc', type: 'object', required: true, description: '地点', properties: [
            { name: 'name', type: 'string', required: true, description: '地点名' },
            { name: 'latitude', type: 'number', required: true, description: '纬度' },
            { name: 'longitude', type: 'number', required: true, description: '经度' },
            { name: 'place_id', type: 'string', required: false, description: '从 places_search 复制' },
            { name: 'notes', type: 'string', required: false, description: '你的小贴士' },
            { name: 'address', type: 'string', required: false, description: '自定义地点地址' },
            { name: 'arrival_time', type: 'string', required: false, description: '到达时间' },
            { name: 'duration_minutes', type: 'integer', required: false, description: '停留时长 (分钟)' },
          ],
        } },
      ],
    } },
    { name: 'mode', type: 'enum', required: false, description: 'markers | itinerary', enumValues: ['markers', 'itinerary'] },
    { name: 'travel_mode', type: 'enum', required: false, description: 'driving | walking | transit | bicycling', enumValues: ['driving', 'walking', 'transit', 'bicycling'] },
    { name: 'show_route', type: 'boolean', required: false, description: '是否显示路线' },
    { name: 'title', type: 'string', required: false, description: '行程标题' },
    { name: 'narrative', type: 'string', required: false, description: '行程叙述' },
  ],
  callExample: `[TOOL:places_map_display_v0]
[P:locations]${'${'}JSON.stringify([{"name":"Senso-ji","latitude":35.7148,"longitude":139.7967,"place_id":"ChIJ..."}])[ENDTOOL]`,
  layerId: 'tool.manifest',
};
