// 2026-06-11: 蚁群 stub
export class PheromoneEngine {
  constructor() {}
  emit() {}
  subscribe() {}
  decay() {}
  getSignals() { return []; }
}
export const PheromoneType = {
  SCOUT: 'scout',
  RECRUIT: 'recruit',
  ALARM: 'alarm',
};
export class AdaptiveHeartbeat {
  constructor() {}
  start() {}
  stop() {}
  tick() {}
}
