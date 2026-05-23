#!/usr/bin/env node
/**
 * planning_extractor.ts
 *
 * 从 planning 类型会话中萃取核心摘要
 * 遵循 context-chains SKILL.md 的 planning schema
 */

interface PlanningSummary {
  session_id: string;
  work_type: 'planning';
  created_at: string;
  gate_at_session: number;
  '关联上下文': Array<{ session_id: string; reason: string; relevance: number }>;
  '核心摘要': {
    goals: Array<{
      description: string;
      acceptance_criteria: string[];
    }>;
    dependencies: Array<{
      on_artifact: string;
      type: 'blocks' | 'informs';
    }>;
    risks: Array<{
      description: string;
      probability: 'high' | 'medium' | 'low';
      mitigation: string;
    }>;
    decision_gaps: Array<{
      question: string;
      stakes: string;
      owner: string;
    }>;
  };
  '风险点': Array<{ 描述: string; 概率: 'high' | 'medium' | 'low'; 缓解措施: string }>;
  '遗迹': string[];
}

function extractGoals(text: string): PlanningSummary['核心摘要']['goals'] {
  const goals: PlanningSummary['核心摘要']['goals'] = [];

  const goalPattern = /(?:目标|goal|目的|我们要|需要完成):\s*(.+)/gi;
  let match;

  while ((match = goalPattern.exec(text)) !== null) {
    goals.push({
      description: match[1].trim(),
      acceptance_criteria: [],
    });
  }

  return goals;
}

function extractDependencies(text: string): PlanningSummary['核心摘要']['dependencies'] {
  const deps: PlanningSummary['核心摘要']['dependencies'] = [];

  const depPattern = /(?:依赖|depends on|取决于|blocked by|依赖于):\s*(.+)/gi;
  let match;

  while ((match = depPattern.exec(text)) !== null) {
    const artifact = match[1].trim();
    const type = text.toLowerCase().includes('block') ? 'blocks' : 'informs';
    deps.push({ on_artifact: artifact, type });
  }

  return deps;
}

function extractRisks(text: string): PlanningSummary['核心摘要']['risks'] {
  const risks: PlanningSummary['核心摘要']['risks'] = [];

  const riskKeywords = ['风险', 'risk', '可能失败', '不确定性', 'concern'];
  const probabilityKeywords = {
    high: ['高', '很可能', 'likely', 'high probability'],
    medium: ['中', '可能', 'possible', 'medium'],
    low: ['低', '不太可能', 'unlikely', 'low probability'],
  };

  const sentences = text.split(/[.!?]/);
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    for (const keyword of riskKeywords) {
      if (lower.includes(keyword)) {
        let probability: 'high' | 'medium' | 'low' = 'medium';
        for (const [prob, words] of Object.entries(probabilityKeywords)) {
          if (words.some(w => lower.includes(w))) {
            probability = prob as 'high' | 'medium' | 'low';
            break;
          }
        }
        risks.push({
          description: sentence.trim().slice(0, 100),
          probability,
          mitigation: '',
        });
      }
    }
  }

  return risks;
}

function extractDecisionGaps(text: string): PlanningSummary['核心摘要']['decision_gaps'] {
  const gaps: PlanningSummary['核心摘要']['decision_gaps'] = [];

  const gapPatterns = [
    /(?:待定|未决定|TBD|to be determined|还未确定):\s*(.+)/gi,
    /(?:谁决定|who decides|owner):\s*(.+)/gi,
    /(?:决策缺口|decision gap):\s*(.+)/gi,
  ];

  for (const pattern of gapPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      gaps.push({
        question: match[1].trim(),
        stakes: '',
        owner: '',
      });
    }
  }

  return gaps;
}

function buildSummary(input: {
  sessionId: string;
  gate: number;
  conversationText: string;
  relatedSessions?: Array<{ sessionId: string; reason: string; relevance: number }>;
}): PlanningSummary {
  return {
    session_id: input.sessionId,
    work_type: 'planning',
    created_at: new Date().toISOString(),
    gate_at_session: input.gate,
    '关联上下文': input.relatedSessions || [],
    '核心摘要': {
      goals: extractGoals(input.conversationText),
      dependencies: extractDependencies(input.conversationText),
      risks: extractRisks(input.conversationText),
      decision_gaps: extractDecisionGaps(input.conversationText),
    },
    '风险点': [],
    '遗迹': [],
  };
}

export { buildSummary, type PlanningSummary };

if (require.main === module) {
  const args = process.argv.slice(2);
  const [sessionId, gate] = args;
  const fs = require('fs');
  const conversationText = args[2]
    ? fs.readFileSync(args[2], 'utf-8')
    : fs.readFileSync('/dev/stdin', 'utf-8');

  const summary = buildSummary({ sessionId, gate: parseInt(gate, 10), conversationText });
  console.log(JSON.stringify(summary, null, 2));
}
