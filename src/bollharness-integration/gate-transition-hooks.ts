/**
 * Gate Transition Hook Manager
 *
 * Handles PreGateTransition and PostGateTransition hooks.
 * Hooks are triggered when a gate transition occurs.
 */

import { EventEmitter } from 'events';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';

const execAsync = promisify(exec);

export interface GateHookConfig {
  gates?: number[];
  matcher?: string;
  type: 'command' | 'skill';
  command?: string;
  skill?: string;
  action?: string;
  timeout?: number;
}

export interface GateTransitionEvent {
  from: number;
  to: number;
  success: boolean;
  blockers: string[];
}

class GateTransitionEmitter extends EventEmitter {}

const transitionEmitter = new GateTransitionEmitter();

const GATE_HOOKS: GateHookConfig[] = [];

let initialized = false;

export function initializeGateHooks(): void {
  if (initialized) return;
  initialized = true;

  loadGateHooksFromSettings();
}

function loadGateHooksFromSettings(): void {
  try {
    const settingsPath = path.join(process.cwd(), 'src', 'bollharness', '.boll', 'settings.json');
    if (!fs.existsSync(settingsPath)) return;

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const gateHooks = settings.hooks?.PreGateTransition || settings.hooks?.PostGateTransition || [];

    for (const hook of gateHooks) {
      if (hook.type === 'command' || hook.type === 'skill') {
        GATE_HOOKS.push(hook as GateHookConfig);
      }
    }
  } catch (e) {
    console.warn('[GateHooks] Failed to load gate hooks from settings:', e);
  }
}

export function onGateTransition(
  phase: 'PreGateTransition' | 'PostGateTransition',
  callback: (event: GateTransitionEvent) => void
): void {
  transitionEmitter.on(phase, callback);
}

export function offGateTransition(
  phase: 'PreGateTransition' | 'PostGateTransition',
  callback: (event: GateTransitionEvent) => void
): void {
  transitionEmitter.off(phase, callback);
}

export function emitGateTransition(event: GateTransitionEvent): void {
  transitionEmitter.emit('PreGateTransition', event);
  transitionEmitter.emit('PostGateTransition', event);
}

function matchGate(gates: number[] | undefined, to: number): boolean {
  if (!gates || gates.length === 0) return true;
  return gates.includes(to);
}

export async function runGateHooks(
  phase: 'PreGateTransition' | 'PostGateTransition',
  event: GateTransitionEvent
): Promise<void> {
  for (const hook of GATE_HOOKS) {
    if (!matchGate(hook.gates, event.to)) continue;

    try {
      if (hook.type === 'command' && hook.command) {
        const timeout = hook.timeout || 10;
        await execAsync(hook.command, { timeout: timeout * 1000, cwd: process.cwd() });
      } else if (hook.type === 'skill' && hook.skill) {
        await runSkillHook(hook.skill, hook.action || 'default', event);
      }
    } catch (e) {
      console.error(`[GateHooks] Hook failed (${phase}):`, e);
    }
  }
}

async function runSkillHook(skill: string, action: string, event: GateTransitionEvent): Promise<void> {
  console.log(`[GateHooks] Running skill hook: ${skill} action=${action} for Gate ${event.from} -> ${event.to}`);
}

export async function executeGateTransitionHooks(
  from: number,
  to: number,
  success: boolean,
  blockers: string[]
): Promise<void> {
  const event: GateTransitionEvent = { from, to, success, blockers };

  await runGateHooks('PreGateTransition', event);
  emitGateTransition(event);
  await runGateHooks('PostGateTransition', event);
}

export function addGateHook(config: GateHookConfig): void {
  GATE_HOOKS.push(config);
}

export function clearGateHooks(): void {
  GATE_HOOKS.length = 0;
}

export function listGateHooks(): GateHookConfig[] {
  return [...GATE_HOOKS];
}
