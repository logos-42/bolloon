#!/usr/bin/env node
/**
 * design_extractor.ts
 *
 * 从 design 类型会话中萃取核心摘要
 * 遵循 context-chains SKILL.md 的 design schema
 */

interface DesignSummary {
  session_id: string;
  work_type: 'design';
  created_at: string;
  gate_at_session: number;
  '关联上下文': Array<{ session_id: string; reason: string; relevance: number }>;
  '核心摘要': {
    design_choices: Array<{
      what: string;
      why: string;
      alternatives_considered: string[];
    }>;
    constraints: Array<{
      type: 'technical' | 'business' | 'temporal';
      description: string;
    }>;
    consumers: Array<{
      type: 'data' | 'behavior' | 'visibility';
      description: string;
    }>;
  };
  '决策缺口': Array<{ 描述: string; 影响: string; 需要什么才能关闭: string }>;
  '风险点': Array<{ 描述: string; 概率: 'high' | 'medium' | 'low'; 缓解措施: string }>;
  '遗迹': string[];
}

function extractDesignChoices(text: string): DesignSummary['核心摘要']['design_choices'] {
  const choices: DesignSummary['核心摘要']['design_choices'] = [];

  // Pattern: "决定 X 而非 Y" or "选择 X 而不是 Y"
  const decisionPattern = /(?:决定|选择|采用|选用|Chose|Selected|Decided)\s+(.+?)\s+(?:而非|instead of|rather than|而不是)\s+(.+)/gi;
  let match;

  while ((match = decisionPattern.exec(text)) !== null) {
    choices.push({
      what: match[1].trim(),
      why: '',
      alternatives_considered: [match[2].trim()],
    });
  }

  // Pattern: "因为...所以决定"
  const becausePattern = /(?:因为|由于|考虑到|Considering|Because)\s*(.+?)[，,]\s*(?:决定|选择|采用)\s+(.+)/gi;
  while ((match = becausePattern.exec(text)) !== null) {
    choices.push({
      what: match[2].trim(),
      why: match[1].trim(),
      alternatives_considered: [],
    });
  }

  return choices;
}

function extractConstraints(text: string): DesignSummary['核心摘要']['constraints'] {
  const constraints: DesignSummary['核心摘要']['constraints'] = [];

  const constraintKeywords = [
    { keyword: '必须', type: 'technical' as const },
    { keyword: '不能', type: 'technical' as const },
    { keyword: '限于', type: 'temporal' as const },
    { keyword: '预算', type: 'business' as const },
    { keyword: '时间', type: 'temporal' as const },
    { keyword: '技术限制', type: 'technical' as const },
    { keyword: '业务要求', type: 'business' as const },
  ];

  const sentences = text.split(/[.!?]/);
  for (const sentence of sentences) {
    for (const { keyword, type } of constraintKeywords) {
      if (sentence.includes(keyword)) {
        constraints.push({
          type,
          description: sentence.trim().slice(0, 100),
        });
      }
    }
  }

  return constraints;
}

function extractConsumers(text: string): DesignSummary['核心摘要']['consumers'] {
  const consumers: DesignSummary['核心摘要']['consumers'] = [];

  const consumerPatterns = [
    { pattern: /(?:数据消费方|data consumer):\s*(.+)/gi, type: 'data' as const },
    { pattern: /(?:行为消费方|behavior consumer):\s*(.+)/gi, type: 'behavior' as const },
    { pattern: /(?:可见性消费方|visibility consumer):\s*(.+)/gi, type: 'visibility' as const },
  ];

  for (const { pattern, type } of consumerPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      consumers.push({
        type,
        description: match[1].trim(),
      });
    }
  }

  return consumers;
}

function buildSummary(input: {
  sessionId: string;
  gate: number;
  conversationText: string;
  relatedSessions?: Array<{ sessionId: string; reason: string; relevance: number }>;
}): DesignSummary {
  return {
    session_id: input.sessionId,
    work_type: 'design',
    created_at: new Date().toISOString(),
    gate_at_session: input.gate,
    '关联上下文': input.relatedSessions || [],
    '核心摘要': {
      design_choices: extractDesignChoices(input.conversationText),
      constraints: extractConstraints(input.conversationText),
      consumers: extractConsumers(input.conversationText),
    },
    '决策缺口': [],
    '风险点': [],
    '遗迹': [],
  };
}

export { buildSummary, type DesignSummary };

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
