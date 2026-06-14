import type { ToolManifest } from './types.js';

export const fetch_sports_data: ToolManifest = {
  id: 'fetch_sports_data',
  name: 'fetch_sports_data',
  oneLine: '获取当前/即将进行/最近的体育数据 (比分/积分榜/比赛统计).',
  description: '对于最近和即将进行的比赛的数据、比分、统计, 优先使用此工具而非 Web 搜索. 工作流: 1) 获取比分 2) 根据比赛 ID 获取统计 3) 然后才回复用户.',
  whenToUse: [
    '用户对某场比赛的比分感兴趣',
    '广泛查询 (最近的 NBA 结果等)',
    '需要详细比赛统计',
  ],
  whenNotToUse: [
    '历史比赛 (很久以前)',
    '非体育数据',
  ],
  parameters: [
    { name: 'data_type', type: 'enum', required: true, description: 'scores | standings | game_stats', enumValues: ['scores', 'standings', 'game_stats'] },
    { name: 'game_id', type: 'string', required: false, description: 'SportRadar 比赛 ID (data_type=game_stats 时必需)' },
    { name: 'league', type: 'enum', required: true, description: 'nfl/nba/nhl/mlb/wnba/ncaafb/ncaamb/ncaawb/epl/la_liga/serie_a/bundesliga/ligue_1/mls/champions_league/tennis/golf/nascar/cricket/mma', enumValues: ['nfl','nba','nhl','mlb','wnba','ncaafb','ncaamb','ncaawb','epl','la_liga','serie_a','bundesliga','ligue_1','mls','champions_league','tennis','golf','nascar','cricket','mma'] },
    { name: 'team', type: 'string', required: false, description: '可选的球队名称' },
  ],
  callExample: `[TOOL:fetch_sports_data]
[P:data_type]scores
[P:league]nba
[ENDTOOL]`,
  layerId: 'tool.manifest',
};
