/**
 * Ant Colony Module - 蚁群心跳系统核心模块
 */

export {
  PheromoneType,
  type PheromoneTrail,
  type PheromoneField,
  type PheromoneDB,
  type AntMessagePayload,
  type HeartbeatDecision,
  type AdaptiveHeartbeatConfig,
  DEFAULT_PHEROMONE_CONFIG,
  DEFAULT_ADAPTIVE_CONFIG,
} from './types.js';

export { PheromoneEngine, pheromoneEngine } from './PheromoneEngine.js';
export { AdaptiveHeartbeat } from './AdaptiveHeartbeat.js';