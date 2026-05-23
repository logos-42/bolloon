#!/usr/bin/env node
/**
 * review_extractor.ts
 *
 * 从 review 类型会话中萃取核心摘要
 * 遵循 context-chains SKILL.md 的 review schema
 */

interface ReviewSummary {
  session_id: string;
  work_type: 'review';
  created_at: string;
  gate_at_session: number;
  '关联上下文': Array<{ session_id: string; reason: string; relevance: number }>;
  '核心摘要': {
    verdict: 'PASS' | 'BLOCK' | 'CONDITIONAL';
    reviewed_artifact: string;
    blocking_issues: Array<{
      severity: 'blocker' | 'warning' | 'nit';
      description: string;
      pattern?: string;
    }>;
    non_blocking_observations: string[];
    reviewer_preference_patterns: Array<{ pattern: string; frequency: number }>;
  };
  '决策缺口': Array<{ 描述: string; 影响: string; 需要什么才能关闭: string }>;
  '风险点': Array<{ 描述: string; 概率: 'high' | 'medium' | 'low'; 缓解措施: string }>;
  '遗迹': string[];
}

function extractVerdict(conversationText: string): ReviewSummary['核心摘要']['verdict'] {
  const upper = conversationText.toUpperCase();
  if (upper.includes('BLOCK') || upper.includes('REJECT') || upper.includes('FAIL')) {
    return 'BLOCK';
  }
  if (upper.includes('CONDITIONAL') || upper.includes('CONDITION')) {
    return 'CONDITIONAL';
  }
  return 'PASS';
}

function extractBlockingIssues(conversationText: string): ReviewSummary['核心摘要']['blocking_issues'] {
  const issues: ReviewSummary['核心摘要']['blocking_issues'] = [];

  // Extract patterns like "blocker:", "issue:", "problem:"
  const blockerPattern = /(?:blocker|blocking|issue|problem|concern):\s*(.+)/gi;
  let match;

  while ((match = blockerPattern.exec(conversationText)) !== null) {
    const desc = match[1].trim();
    const severity = desc.toLowerCase().includes('nit')
      ? 'nit'
      : desc.toLowerCase().includes('warning')
        ? 'warning'
        : 'blocker';

    issues.push({ severity, description: desc });
  }

  return issues;
}

function extractPreferencePatterns(conversationText: string): ReviewSummary['核心摘要']['reviewer_preference_patterns'] {
  const patterns: ReviewSummary['核心摘要']['reviewer_preference_patterns'] = [];

  // Common reviewer preference keywords
  const prefKeywords = [
    'should always', 'must be', 'avoid', 'prefer', 'recommend',
    'never', 'always', 'consider', 'take care', '注意',
  ];

  const sentences = conversationText.split(/[.!?]/);
  const prefCounts: Record<string, number> = {};

  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    for (const keyword of prefKeywords) {
      if (lower.includes(keyword)) {
        const normalized = sentence.trim().slice(0, 50);
        prefCounts[normalized] = (prefCounts[normalized] || 0) + 1;
      }
    }
  }

  for (const [pattern, count] of Object.entries(prefCounts)) {
    if (count >= 2) {
      patterns.push({ pattern, frequency: count });
    }
  }

  return patterns;
}

function buildSummary(input: {
  sessionId: string;
  gate: number;
  conversationText: string;
  relatedSessions?: Array<{ sessionId: string; reason: string; relevance: number }>;
}): ReviewSummary {
  return {
    session_id: input.sessionId,
    work_type: 'review',
    created_at: new Date().toISOString(),
    gate_at_session: input.gate,
    '关联上下文': input.relatedSessions || [],
    '核心摘要': {
      verdict: extractVerdict(input.conversationText),
      reviewed_artifact: '',
      blocking_issues: extractBlockingIssues(input.conversationText),
      non_blocking_observations: [],
      reviewer_preference_patterns: extractPreferencePatterns(input.conversationText),
    },
    '决策缺口': [],
    '风险点': [],
    '遗迹': [],
  };
}

export { buildSummary, type ReviewSummary };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: review_extractor.ts <session_id> <gate> [conversation_file]');
    process.exit(1);
  }

  const [sessionId, gate] = args;
  const fs = require('fs');
  const conversationText = args[2]
    ? fs.readFileSync(args[2], 'utf-8')
    : fs.readFileSync('/dev/stdin', 'utf-8');

  const summary = buildSummary({ sessionId, gate: parseInt(gate, 10), conversationText });
  console.log(JSON.stringify(summary, null, 2));
}
