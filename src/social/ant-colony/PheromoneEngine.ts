/**
 * PheromoneEngine - 信息素管理引擎
 *
 * 模拟蚂蚁的信息素系统，用于引导智能体发现和路由决策
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
  PheromoneType,
  PheromoneTrail,
  PheromoneField,
  PheromoneDB,
  DEFAULT_PHEROMONE_CONFIG,
} from './types.js';

export { PheromoneType };

const PHEROMONE_DB_PATH = path.join(
  process.env.HOME || '/tmp',
  '.bolloon',
  'ant-colony',
  'pheromones.json'
);

export class PheromoneEngine {
  private trails: Map<string, PheromoneTrail> = new Map();
  private fields: Map<string, PheromoneField> = new Map();
  private evaporationTimer: ReturnType<typeof setInterval> | null = null;
  private saveTimer: ReturnType<typeof setInterval> | null = null;
  private dirty: boolean = false;

  async initialize(): Promise<void> {
    await fs.mkdir(path.dirname(PHEROMONE_DB_PATH), { recursive: true });
    await this.load();
    this.startEvaporation();
    this.startAutoSave();
  }

  private startEvaporation(): void {
    this.evaporationTimer = setInterval(() => {
      this.evaporate();
    }, DEFAULT_PHEROMONE_CONFIG.evaporationInterval);
  }

  private startAutoSave(): void {
    this.saveTimer = setInterval(() => {
      if (this.dirty) {
        this.save().catch(console.error);
        this.dirty = false;
      }
    }, 30000);
  }

  /**
   * 放置信息素
   */
  async deposit(
    type: PheromoneType,
    sourceDid: string,
    targetDid: string,
    strength: number = 0.5,
    options?: {
      capability?: string[];
      qualityScore?: number;
    }
  ): Promise<void> {
    const key = this.getTrailKey(type, sourceDid, targetDid);
    const existing = this.trails.get(key);

    const newStrength = existing
      ? Math.min(1, existing.strength + strength * 0.3)
      : Math.min(1, strength);

    const trail: PheromoneTrail = {
      id: key,
      type,
      sourceDid,
      targetDid,
      strength: newStrength,
      decayRate: DEFAULT_PHEROMONE_CONFIG.decayRate,
      createdAt: existing?.createdAt || Date.now(),
      lastUpdate: Date.now(),
      capability: options?.capability,
      qualityScore: options?.qualityScore,
    };

    this.trails.set(key, trail);
    this.dirty = true;

    if (options?.capability) {
      this.updateField(type, targetDid, options.capability);
    }
  }

  /**
   * 读取某方向的信息素强度
   */
  getStrength(type: PheromoneType, targetDid: string): number {
    let totalStrength = 0;
    let count = 0;

    for (const trail of this.trails.values()) {
      if (trail.type === type && trail.targetDid === targetDid) {
        totalStrength += trail.strength;
        count++;
      }
    }

    return count > 0 ? totalStrength / count : 0;
  }

  /**
   * 查询特定能力的最佳节点
   */
  queryByCapability(capability: string, limit: number = 5): string[] {
    const field = this.fields.get(capability);
    if (!field) return [];

    const candidates: { did: string; strength: number }[] = [];

    for (const trail of this.trails.values()) {
      if (
        trail.type === PheromoneType.CAPABILITY &&
        trail.capability?.includes(capability)
      ) {
        const score = trail.strength * (trail.qualityScore || 0.5);
        candidates.push({ did: trail.targetDid, strength: score });
      }
    }

    candidates.sort((a, b) => b.strength - a.strength);
    return candidates.slice(0, limit).map((c) => c.did);
  }

  /**
   * 获取到达某节点的最佳下一跳
   */
  getNextHop(targetDid: string, excludeDids: string[] = []): string | null {
    let bestHop: string | null = null;
    let bestStrength = 0;

    for (const trail of this.trails.values()) {
      if (trail.targetDid === targetDid && trail.strength > bestStrength) {
        if (!excludeDids.includes(trail.sourceDid)) {
          bestHop = trail.sourceDid;
          bestStrength = trail.strength;
        }
      }
    }

    return bestHop;
  }

  /**
   * 获取所有已知节点及其信息素强度
   */
  getAllNodeStrengths(): Map<string, number> {
    const result = new Map<string, number>();

    for (const trail of this.trails.values()) {
      const current = result.get(trail.targetDid) || 0;
      result.set(trail.targetDid, Math.max(current, trail.strength));
    }

    return result;
  }

  /**
   * 获取信息素统计
   */
  getStats(): {
    totalTrails: number;
    avgStrength: number;
    capabilityCount: number;
  } {
    let totalStrength = 0;
    for (const trail of this.trails.values()) {
      totalStrength += trail.strength;
    }

    return {
      totalTrails: this.trails.size,
      avgStrength: this.trails.size > 0 ? totalStrength / this.trails.size : 0,
      capabilityCount: this.fields.size,
    };
  }

  private getTrailKey(type: PheromoneType, source: string, target: string): string {
    return `${type}:${source}:${target}`;
  }

  private updateField(
    type: PheromoneType,
    targetDid: string,
    capability?: string[]
  ): void {
    if (!capability) return;

    for (const cap of capability) {
      let field = this.fields.get(cap);
      if (!field) {
        field = {
          capability: cap,
          avgStrength: 0,
          nodeCount: 0,
          lastUpdate: Date.now(),
        };
        this.fields.set(cap, field);
      }

      const trails = Array.from(this.trails.values()).filter(
        (t) => t.type === type && t.capability?.includes(cap)
      );

      field.avgStrength =
        trails.reduce((sum, t) => sum + t.strength, 0) / (trails.length || 1);
      field.nodeCount = new Set(trails.map((t) => t.targetDid)).size;
      field.lastUpdate = Date.now();
    }
  }

  private evaporate(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [key, trail] of this.trails.entries()) {
      const ageHours = (now - trail.lastUpdate) / (1000 * 60 * 60);
      const decayFactor = Math.pow(1 - trail.decayRate, ageHours);
      trail.strength = trail.strength * decayFactor;

      if (
        trail.strength < DEFAULT_PHEROMONE_CONFIG.minStrength ||
        now - trail.createdAt > DEFAULT_PHEROMONE_CONFIG.maxTrailAge
      ) {
        toDelete.push(key);
      } else {
        trail.lastUpdate = now;
      }
    }

    for (const key of toDelete) {
      this.trails.delete(key);
    }

    if (toDelete.length > 0) {
      this.dirty = true;
      this.save().catch(console.error);
    }
  }

  private async save(): Promise<void> {
    try {
      const data: PheromoneDB = {
        trails: Array.from(this.trails.values()),
        fields: Array.from(this.fields.entries()),
      };
      await fs.writeFile(PHEROMONE_DB_PATH, JSON.stringify(data, null, 2));
    } catch (e) {
      console.warn('[PheromoneEngine] Save failed:', e);
    }
  }

  private async load(): Promise<void> {
    try {
      const data = await fs.readFile(PHEROMONE_DB_PATH, 'utf-8');
      const parsed: PheromoneDB = JSON.parse(data);

      this.trails.clear();
      for (const t of parsed.trails || []) {
        this.trails.set(t.id, t);
      }

      this.fields.clear();
      for (const [cap, field] of parsed.fields || []) {
        this.fields.set(cap, field);
      }

      console.log(
        `[PheromoneEngine] Loaded ${this.trails.size} trails, ${this.fields.size} fields`
      );
    } catch {
      console.log('[PheromoneEngine] No existing pheromone data, starting fresh');
    }
  }

  shutdown(): void {
    if (this.evaporationTimer) {
      clearInterval(this.evaporationTimer);
    }
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
    }
    if (this.dirty) {
      this.save()
        .then(() => console.log('[PheromoneEngine] Saved on shutdown'))
        .catch(console.error);
    }
  }
}

export const pheromoneEngine = new PheromoneEngine();