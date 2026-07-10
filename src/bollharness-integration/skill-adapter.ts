/**
 * Skill Adapter - Bridge between Bollharness skills and Bolloon's SkillRegistry
 * 
 * Loads skills from src/bollharness/.claude/skills/ and adapts them for Bolloon.
 * 
 * Skill structure (from bollharness):
 * - arch: Project architect (architecture decisions, boundary freezing)
 * - lead: Development workflow commander (fail-closed state machine)
 * - task-arch: Task decomposition
 * - harness-eng: Engineering execution
 * - harness-dev: Development execution
 * - harness-eng-test: Engineering testing
 * - harness-ops: Operations and truth maintenance
 * - harness-bridge: Bridge agent coordination
 * - crystal-learn: Failure pattern extraction
 * - bug-triage: Bug classification
 * - bug-pipeline: Bug fix pipeline
 * - guardian-fixer: Issue-to-fix workflow
 * - plan-lock: Plan freezing
 * - skill-discovery: Skill discovery and recommendation
 * - toolkit: Toolkit management
 */

import { SkillRegistry, Skill } from '@bolloon/constraint-runtime';

type LlmClient = {
  chat: (messages: { role: string; content: string }[], systemPrompt?: string, signal?: any) => Promise<{ reply: string }>;
};
import * as fs from 'fs';
import * as path from 'path';

export const BOLLHARNESS_SKILLS_DIR = path.join('src', 'bollharness', '.claude', 'skills');

export interface HarnessSkillMetadata {
  name: string;
  description: string;
  status: 'active' | 'deprecated' | 'experimental';
  tier: 'entry' | 'intermediate' | 'advanced' | 'meta' | 'execution';
  owner?: string;
  last_audited?: string;
  triggers?: string[];
  outputs?: string[];
  truth_policy?: string[];
}

function parseYamlFrontmatter(content: string): { metadata: HarnessSkillMetadata; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { metadata: { name: '', description: '', status: 'active', tier: 'entry' }, body: content };
  }

  const yamlStr = match[1];
  const body = match[2];
  const metadata: Record<string, unknown> = {};

  for (const line of yamlStr.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    let value: unknown = line.slice(colonIndex + 1).trim();
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (!isNaN(Number(value)) && value !== '') value = Number(value);
    metadata[key] = value;
  }

  return {
    metadata: metadata as unknown as HarnessSkillMetadata,
    body,
  };
}

function loadHarnessSkill(skillPath: string): HarnessSkillMetadata | null {
  try {
    const skillDir = path.dirname(skillPath);
    const skillName = path.basename(skillDir);
    const content = fs.readFileSync(skillPath, 'utf-8');
    const { metadata } = parseYamlFrontmatter(content);
    metadata.name = skillName;
    return metadata;
  } catch {
    return null;
  }
}

function loadAllHarnessSkills(): HarnessSkillMetadata[] {
  const skills: HarnessSkillMetadata[] = [];

  if (!fs.existsSync(BOLLHARNESS_SKILLS_DIR)) {
    console.warn(`[SkillAdapter] Bollharness skills dir not found: ${BOLLHARNESS_SKILLS_DIR}`);
    return skills;
  }

  const entries = fs.readdirSync(BOLLHARNESS_SKILLS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(BOLLHARNESS_SKILLS_DIR, entry.name, 'SKILL.md');
    if (fs.existsSync(skillPath)) {
      const metadata = loadHarnessSkill(skillPath);
      if (metadata) {
        skills.push(metadata);
      }
    }
  }

  return skills;
}

export interface SkillTriggers {
  keywords: string[];
  patterns: RegExp[];
  contexts: string[];
}

export interface AdaptedSkill {
  name: string;
  description: string;
  triggers: SkillTriggers;
  execute: (params: Record<string, unknown>) => Promise<string>;
  getGatePack?: () => Record<string, unknown>;
}

export interface SkillMetadata {
  name: string;
  tier: 'entry' | 'intermediate' | 'advanced';
  status: 'active' | 'deprecated' | 'experimental';
  owner?: string;
  last_audited?: string;
}

/**
 * Base skill class for bollharness-compatible skills
 */
export abstract class BaseSkill implements Skill {
  abstract name: string;
  abstract description: string;

  private static llm: LlmClient | null = null;

  static setLlm(instance: LlmClient): void {
    BaseSkill.llm = instance;
  }

  abstract execute(params: Record<string, unknown>): Promise<string>;

  protected log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : 'ℹ️';
    console.log(`${prefix} [${this.name}] ${message}`);
  }

  protected formatOutput(output: Record<string, unknown>): string {
    return JSON.stringify(output, null, 2);
  }

  protected async callLm(system: string, user: string): Promise<string> {
    let llm = BaseSkill.llm;
    if (!llm) {
      try {
        const { getMinimax } = await import('../llm/pi-ai.js');
        const m = getMinimax();
        if (m && typeof m.chat === 'function') {
          BaseSkill.setLlm(m as unknown as LlmClient);
          llm = m as unknown as LlmClient;
        }
      } catch {
        return this.formatOutput({ warning: 'LLM 未注入', name: this.name });
      }
    }
    if (!llm) {
      return this.formatOutput({ warning: 'LLM 未注入', name: this.name });
    }
    try {
      const res = await llm.chat([{ role: 'user', content: user }], system);
      return res.reply || '(空回复)';
    } catch (err: any) {
      this.log(`LLM 调用失败: ${err.message}`, 'error');
      return this.formatOutput({ error: `LLM 调用失败: ${err.message}` });
    }
  }
}

/**
 * Architecture Skill - Project architect for architecture decisions
 */
export class ArchSkill extends BaseSkill {
  name = 'arch';
  description = 'Project architect. Responsible for architecture decisions, scheme comparison, and boundary freezing.';

  async execute(params: Record<string, unknown>): Promise<string> {
    const task = (params.task || params.description || params.action || '') as string;
    
    this.log('Analyzing architecture task');

    if (!task) {
      return this.formatOutput({ warning: '未提供任务', usage: '--harness-skill arch "你的架构任务"' });
    }

    return this.callLm(
      'You are a senior software architect. Analyze the task and output structured JSON with fields: essence, tensions, alternatives, boundaries, recommendation.',
      `Architecture task: ${task}`
    );
  }
}

/**
 * Lead Skill - Development workflow commander (fail-closed state machine)
 */
export class LeadSkill extends BaseSkill {
  name = 'lead';
  description = 'Development workflow commander. Fail-closed state machine from idea to production code.';

  private currentGate = 0;

  async execute(params: Record<string, unknown>): Promise<string> {
    const action = params.action as string;
    
    this.log('Processing lead action');

    switch (action) {
      case 'get_gate':
        return this.getGatePack();
      case 'transition':
        return this.handleTransition(params);
      case 'classify':
        return this.classifyChange(params);
      default:
        return this.getGatePack();
    }
  }

  getGatePack(): string {
    const gates = [
      { gate: 0, name: 'Problem Lock', required: 'Problem statement + Change Classification' },
      { gate: 1, name: 'Architecture Design', required: 'ADR draft + Consumer list' },
      { gate: 2, name: 'Architecture Review', required: 'Review report (PASS/BLOCK)' },
      { gate: 3, name: 'Plan', required: 'PLAN document + Coverage matrix' },
      { gate: 4, name: 'Plan Review', required: 'Review report + plan-lock' },
      { gate: 5, name: 'Task Architecture', required: 'WP split + TASK.md' },
      { gate: 6, name: 'Task Review', required: 'Review report (PASS/BLOCK)' },
      { gate: 7, name: 'Execution', required: 'Code + LOG.md' },
      { gate: 8, name: 'Final Review', required: 'Review report + Acceptance' },
    ];

    const current = gates[this.currentGate];

    return this.formatOutput({
      current_gate: this.currentGate,
      gate_name: current.name,
      entry_satisfied: true,
      blockers: [],
      required_artifact: current.required,
      required_next_skill: 'arch',
      available_actions: ['get_gate', 'transition', 'classify'],
    });
  }

  private handleTransition(params: Record<string, unknown>): string {
    const reviewResult = params.reviewResult as { verdict: string } | undefined;
    
    // Check if review gate needs PASS
    if (this.currentGate === 2 || this.currentGate === 4 || this.currentGate === 6 || this.currentGate === 8) {
      if (!reviewResult || reviewResult.verdict !== 'PASS') {
        return this.formatOutput({
          transition: 'BLOCKED',
          reason: 'Review gate requires PASS verdict from independent reviewer',
          current_gate: this.currentGate,
        });
      }
    }

    this.currentGate = Math.min(8, this.currentGate + 1);
    
    return this.formatOutput({
      transition: 'SUCCESS',
      from_gate: this.currentGate - 1,
      to_gate: this.currentGate,
      gate_pack: this.getGatePack(),
    });
  }

  private async classifyChange(params: Record<string, unknown>): Promise<string> {
    const description = params.description as string || '';

    return this.callLm(
      'You are a change classifier. Given a description, classify the change as policy, contract, or implementation. Output JSON: { classification, description, minimum_gate_path, fast_track_eligible }.',
      `Classify this change: ${description}`
    );
  }
}

/**
 * Task Architecture Skill - Task decomposition
 */
export class TaskArchSkill extends BaseSkill {
  name = 'task-arch';
  description = 'Task decomposition. Breaks down PLAN into parallelizable work packages (WP).';

  async execute(params: Record<string, unknown>): Promise<string> {
    const plan = (params.plan || params.task || params.description || params.action || '') as string;
    
    this.log('Decomposing plan into work packages');

    if (!plan) {
      return this.formatOutput({ warning: '未提供 plan', usage: '--harness-skill task-arch "你的开发计划"' });
    }

    return this.callLm(
      'You are a task decomposition specialist. Given a plan, break it down into work packages (WP) with seams and integration points. Output JSON: { work_packages, seams, integration }.',
      `Plan: ${plan}`
    );
  }
}

/**
 * Harness Engineering Skill - Engineering execution
 */
export class HarnessEngSkill extends BaseSkill {
  name = 'harness-eng';
  description = 'Engineering execution. Implements code according to PLAN.';

  async execute(params: Record<string, unknown>): Promise<string> {
    const workPackage = params.workPackage as string;
    const plan = params.plan as string;
    
    this.log(`Executing work package: ${workPackage}`);

    // Verify prerequisites
    const prereqs = this.checkPrerequisites(workPackage);
    
    // Execute implementation
    const steps = this.planImplementation(workPackage, plan);
    
    // Log execution
    const log = this.createExecutionLog(steps);

    return this.formatOutput({
      work_package: workPackage,
      prerequisites: prereqs,
      steps,
      log,
      status: prereqs.met ? 'ready' : 'blocked',
    });
  }

  private checkPrerequisites(workPackage: string): { met: boolean; missing: string[] } {
    // Simplified check
    return { met: true, missing: [] };
  }

  private planImplementation(workPackage: string, plan: string): string[] {
    return [
      'Step 1: Implement core logic',
      'Step 2: Add error handling',
      'Step 3: Write unit tests',
      'Step 4: Update documentation',
    ];
  }

  private createExecutionLog(steps: string[]): string {
    return `# Execution Log\n\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
  }
}

/**
 * Harness Engineering Test Skill - Test strategy and execution
 * Ported from src/bollharness/.claude/skills/harness-eng-test/SKILL.md
 */
export class HarnessEngTestSkill extends BaseSkill {
  name = 'harness-eng-test';
  description = 'Testing engineering specialist. Test strategy, test case design, test execution and quality verification. Scheduled by lead at Gate 8.';

  async execute(params: Record<string, unknown>): Promise<string> {
    const action = params.action as string;
    const plan = params.plan as string;
    const frozen = params.frozen as boolean;

    this.log('Executing test engineering');

    if (action === 'strategy') {
      return this.createTestStrategy(plan);
    }

    if (action === 'cases') {
      return this.createTestCases(plan);
    }

    if (action === 'execute') {
      return this.executeTests();
    }

    return this.formatOutput({
      skill: this.name,
      description: this.description,
      available_actions: ['strategy', 'cases', 'execute'],
      gate_8_only: true,
      truth_policy: [
        'Tests must be independent from implementation',
        'Test coverage does not equal test quality',
        'Report test results honestly',
      ],
    });
  }

  private createTestStrategy(plan: string): string {
    const layers = [
      { layer: 'Unit tests', target: 'Fast feedback', tool: 'vitest' },
      { layer: 'Integration tests', target: 'Module interfaces', tool: 'supertest' },
      { layer: 'E2E tests', target: 'User journeys', tool: 'playwright' },
    ];

    return this.formatOutput({
      test_strategy: layers,
      coverage_target: plan.includes('API') ? 'contract-focused' : 'function-focused',
      fast_track_eligible: false,
    });
  }

  private createTestCases(plan: string): string {
    return this.formatOutput({
      test_cases: [
        { id: 'TC-1', description: 'Core functionality', priority: 'P0' },
        { id: 'TC-2', description: 'Edge cases', priority: 'P1' },
        { id: 'TC-3', description: 'Error handling', priority: 'P1' },
      ],
      requirements: plan,
    });
  }

  private executeTests(): string {
    return this.formatOutput({
      execution_report: {
        status: 'NOT_EXECUTED',
        message: 'Test execution requires bollharness environment',
      },
      truth_policy: [
        '"collect passed" ≠ "tests passed"',
        'Failure is failure, do not downgrade',
        'BLOCKED must be explicitly marked',
      ],
    });
  }
}

/**
 * Crystal Learn Skill - Failure pattern extraction
 */
export class CrystalLearnSkill extends BaseSkill {
  name = 'crystal-learn';
  description = 'Extracts failure patterns and maintains invariants.';

  async execute(params: Record<string, unknown>): Promise<string> {
    const task = (params.task || params.description || params.action || '') as string;
    
    this.log('Extracting failure patterns from: ' + (task || '(空)'));

    if (!task) {
      return this.formatOutput({ warning: '未提供任务', usage: '--harness-skill crystal-learn "你的任务描述"' });
    }

    return this.callLm(
      'You are a failure pattern analyst. Extract failure modes, patterns, and invariants from the task description. Output structured JSON with failure_modes, patterns, invariants.',
      `Task: ${task}`
    );
  }
}

// ============================================================
// 2026-07-10 双栖 agent 网络新增 3 个 skill
// (peer-sync / habit-distill / target-tracker)
// ============================================================

/**
 * Peer-Sync Skill — 主动找对端协作.
 *
 * 调用流程:
 * 1. 拿 list_peers (通过 p2pNetwork.getPeers() 或已注入的 ctx.tools)
 * 2. 用 LLM 选最合适的 peer (按 expertise tag / 在线时长 / 任务匹配)
 * 3. send_message 问对方是否接 + 预算
 * 4. 同意后 send_to_channel 建带 target_id 的 channel
 */
export class PeerSyncSkill extends BaseSkill {
  name = 'peer-sync';
  description = '主动找对端 bolloon 节点协作. 接收 target_id + task, 自动选 peer + 建 channel. 写 channel 时调 sessionStore.saveMessages + chatArchiver (via goal-resume event log).';

  async execute(params: Record<string, unknown>): Promise<string> {
    const targetId = (params.target_id || params.targetId || '') as string;
    const task = (params.task || params.description || '') as string;

    if (!targetId || !task) {
      return this.formatOutput({
        warning: 'target_id 和 task 必填',
        usage: '--harness-skill peer-sync --target_id "完成 X" --task "实现 Y"',
      });
    }

    this.log(`peer-sync 启动: target_id=${targetId}`);

    // 选 peer 的策略由 LLM 决定 (根据 list_peers 输出 + expertise tag)
    return this.callLm(
      `You are a peer-selection specialist for the bolloon P2P network.
Given a target_id and task description, output structured JSON with:
- selectedPeer: DID of the best peer (or null if none suitable)
- channelName: human-readable name for the new channel
- initialMessage: first message to send (≤ 200 chars, brief + asks for acceptance)
- estimatedRounds: expected back-and-forth count (1-10)

Rules:
- Prefer peers with matching expertise tag
- If no peer matches, return selectedPeer: null
- Don't over-explain — peer agent has same identity layer as you`,
      `target_id: ${targetId}\ntask: ${task}`,
    );
  }
}

/**
 * Habit-Distill Skill — 提炼用户习性, 写到 judgment 库.
 *
 * 调用流程:
 * 1. sessionStore.loadMessages(channelId) 拿当前 session 末 30 条
 * 2. LLM 抽取用户习性 (输入习惯 / 偏好术语 / 反复问的主题 / 纠正记录)
 * 3. humanValueStore.storeHumanJudgment({ content, tags: ['habit'], source: 'habit-distill', privacy: 'private' })
 */
export class HabitDistillSkill extends BaseSkill {
  name = 'habit-distill';
  description = '从当前 session 提炼用户习性, 写到 ~/.bolloon/human-values/judgments.json. 调 humanValueStore.storeHumanJudgment, 标签 privacy:private.';

  async execute(params: Record<string, unknown>): Promise<string> {
    const sessionKey = (params.session_key || params.sessionKey || '') as string;
    const recentMessagesSummary = (params.messages_summary || '') as string;

    if (!sessionKey) {
      return this.formatOutput({
        warning: 'session_key 必填',
        usage: '--harness-skill habit-distill --session_key <key>',
      });
    }

    this.log(`habit-distill 启动: session=${sessionKey}`);

    // 抽取习性的 prompt — 让 LLM 输出结构化 JSON
    return this.callLm(
      `You are a habit-extraction specialist.
Given a summary of user-assistant interaction, output JSON with:
- habits: [{ content: string, tags: string[], weight: 'low'|'medium'|'high' }]
  - content: 一个用户偏好/习性的简短描述 (≤ 100 字)
  - tags: 标签如 ['input-style', 'terminology', 'recurring-topic', 'correction']
  - weight: 影响判断力注入门时的优先级
- skipReason: 若不该蒸馏 (用户拒绝/任务太简单/judgment 库饱和), 填理由

Rules:
- 习性必须是"用户可观察到的稳定模式", 不是单次偏好
- 隐私相关打 tags 含 'private', 注入门自动过滤
- 不要重复已有 judgment (调用方负责查重)`,
      `Session: ${sessionKey}\nMessages summary: ${recentMessagesSummary || '(caller should pass loadMessages output)'}`,
    );
  }
}

/**
 * Target-Tracker Skill — 跨 channel 查 target_id 进展.
 *
 * 调用流程:
 * 1. goal-resume.ts 的 listParkedGoals({ targetIdPrefix: <id> }) 查所有匹配的 snapshot
 * 2. chatArchiver.listPeerSummaries 查 channel 维度
 * 3. 输出结构化 status: { goalId, targetId, parkedAt, reason, recentProgress[] }
 */
export class TargetTrackerSkill extends BaseSkill {
  name = 'target-tracker';
  description = '跨 channel 查 target_id 进展. 调 goal-resume listParkedGoals + chatArchiver.listPeerSummaries. 用于切 channel 时不丢目标状态.';

  async execute(params: Record<string, unknown>): Promise<string> {
    const targetId = (params.target_id || params.targetId || '') as string;
    const originChannel = (params.origin_channel || '') as string;

    if (!targetId && !originChannel) {
      return this.formatOutput({
        warning: 'target_id 或 origin_channel 至少传一个',
        usage: '--harness-skill target-tracker --target_id <id>',
      });
    }

    this.log(`target-tracker 启动: target_id=${targetId} channel=${originChannel}`);

    // status JSON 由调用方负责真实查询 (skill 接收参数, 返回查询模板)
    return this.formatOutput({
      skill: this.name,
      description: this.description,
      query_params: { targetId, originChannel },
      action: 'caller must invoke goal-resume.listParkedGoals + chatArchiver.listPeerSummaries with these params',
      expected_output: 'List of GoalSnapshot + per-channel progress summary',
    });
  }
}

/**
 * Skill Adapter - Registers all bollharness skills with Bolloon's SkillRegistry
 */
export class SkillAdapter {
  private registry: SkillRegistry;
  private harnessSkills: HarnessSkillMetadata[] = [];

  constructor() {
    this.registry = new SkillRegistry();
    this.registerSkills();
  }

  private registerSkills(): void {
    // Load harness skills from src/bollharness/.claude/skills/
    this.harnessSkills = loadAllHarnessSkills();
    this.log(`Loaded ${this.harnessSkills.length} skills from bollharness`);

    // Register adapted skills for skills not yet fully adapted
    const adaptedSkills: Skill[] = [
      new ArchSkill(),
      new LeadSkill(),
      new TaskArchSkill(),
      new HarnessEngSkill(),
      new HarnessEngTestSkill(),
      new CrystalLearnSkill(),
      // 2026-07-10 双栖 agent 网络新增 3 个:
      new PeerSyncSkill(),
      new HabitDistillSkill(),
      new TargetTrackerSkill(),
    ];

    for (const skill of adaptedSkills) {
      try {
        this.registry.register(skill);
        this.log(`Registered adapted skill: ${skill.name}`);
      } catch (error) {
        this.log(`Failed to register ${skill.name}: ${error}`, 'error');
      }
    }

    // Register harness-native skills (metadata only, execution delegated)
    for (const harnessMeta of this.harnessSkills) {
      const adaptedNames = adaptedSkills.map(s => s.name);
      if (!adaptedNames.includes(harnessMeta.name)) {
        try {
          const proxySkill = createHarnessProxySkill(harnessMeta);
          this.registry.register(proxySkill);
          this.log(`Registered harness proxy skill: ${harnessMeta.name}`);
        } catch (error) {
          this.log(`Failed to register harness skill ${harnessMeta.name}: ${error}`, 'error');
        }
      }
    }
  }

  getRegistry(): SkillRegistry {
    return this.registry;
  }

  getSkill(name: string): Skill | undefined {
    return this.registry.get(name);
  }

  injectLlm(llm: LlmClient): void {
    BaseSkill.setLlm(llm);
    this.log('LLM 已注入到所有 BaseSkill');
  }

  listSkills(): Skill[] {
    return this.registry.list();
  }

  listHarnessSkills(): HarnessSkillMetadata[] {
    return this.harnessSkills;
  }

  async executeSkill(name: string, params: Record<string, unknown>): Promise<string> {
    return this.registry.execute(name, params);
  }

  private log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    // 2026-07-06: info 默认静音 — 14 条 [SkillAdapter] Loaded/Registered 日志刷屏 web.log
    //   调试时设 BOLLOON_VERBOSE=1 临时开起来. warn/error 仍正常打.
    const VERBOSE = typeof process !== 'undefined' && process.env?.BOLLOON_VERBOSE === '1';
    if (level === 'info' && !VERBOSE) return;
    const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : 'ℹ️';
    console.log(`${prefix} [SkillAdapter] ${message}`);
  }
}

function createHarnessProxySkill(meta: HarnessSkillMetadata): Skill {
  return {
    name: meta.name,
    description: meta.description,
    async execute(params: Record<string, unknown>): Promise<string> {
      return JSON.stringify({
        skill: meta.name,
        description: meta.description,
        tier: meta.tier,
        status: meta.status,
        outputs: meta.outputs || [],
        message: `Harness skill '${meta.name}' requires bollharness environment for full execution`,
        params_received: params,
      }, null, 2);
    },
  };
}

export const createSkillAdapter = (): SkillAdapter => {
  return new SkillAdapter();
};
