/**
 * Ant Colony Types - 信息素系统类型定义
 */

export enum PheromoneType {
  DISCOVERY = 'discovery',
  CAPABILITY = 'capability',
}

export interface PheromoneTrail {
  id: string;
  type: PheromoneType;
  sourceDid: string;
  targetDid: string;
  strength: number;
  decayRate: number;
  createdAt: number;
  lastUpdate: number;
  capability?: string[];
  qualityScore?: number;
}

export interface PheromoneField {
  capability: string;
  avgStrength: number;
  nodeCount: number;
  lastUpdate: number;
}

export interface PheromoneDB {
  trails: PheromoneTrail[];
  fields: [string, PheromoneField][];
}

export interface AntMessagePayload {
  id: string;
  antId: string;
  originDid: string;
  originName: string;
  originPublicKey: string;
  targetCapability: string[];
  ttl: number;
  maxHops: number;
  currentHop: number;
  path: Array<{
    did: string;
    peerId: string;
    timestamp: number;
  }>;
  payload: {
    personaCid?: string;
    ipnsName?: string;
    interests?: string[];
    recommendedBy?: string;
    qualityScore?: number;
  };
  timestamp: number;
  signature: string;
}

export interface HeartbeatDecision {
  interval: number;
  shouldExplore: boolean;
  shouldBroadcast: boolean;
  priorityLevel: 'low' | 'normal' | 'high' | 'urgent';
}

export interface AdaptiveHeartbeatConfig {
  minInterval: number;
  maxInterval: number;
  baseInterval: number;
  lowActivityThreshold: number;
  highActivityThreshold: number;
  pheromoneBoostFactor: number;
  discoveryBoostFactor: number;
}

export const DEFAULT_PHEROMONE_CONFIG = {
  decayRate: 0.05,
  evaporationInterval: 5 * 60 * 1000,
  maxTrailAge: 24 * 60 * 60 * 1000,
  minStrength: 0.05,
  maxStrength: 1.0,
};

export const DEFAULT_ADAPTIVE_CONFIG: AdaptiveHeartbeatConfig = {
  minInterval: 10 * 1000,
  maxInterval: 120 * 1000,
  baseInterval: 30 * 1000,
  lowActivityThreshold: 0.5,
  highActivityThreshold: 5,
  pheromoneBoostFactor: 0.3,
  discoveryBoostFactor: 0.4,
};