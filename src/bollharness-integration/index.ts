/**
 * Bollharness Integration for Bolloon
 * 
 * This module provides compatibility between Bolloon's multi-agent system
 * and Bollharness's governance framework.
 * 
 * Key features:
 * - Skill system alignment (16 skills → Bolloon's SkillRegistry)
 * - Guard mechanism (checks → guardrails)
 * - Gate state machine (8 gates for workflow governance)
 * - Context routing (path-based automatic context injection)
 */

export { BollharnessIntegration, createBollharnessIntegration } from './integration.js';
export { GateStateMachine, type Gate } from './gate-state-machine.js';
export { GuardChecker, type GuardFinding, type GuardResult } from './guard-checker.js';
export { ContextRouter } from './context-router.js';
export { SkillAdapter, type AdaptedSkill, type SkillTriggers, type HarnessSkillMetadata } from './skill-adapter.js';
