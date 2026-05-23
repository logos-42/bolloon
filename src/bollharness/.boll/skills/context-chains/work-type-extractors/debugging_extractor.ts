#!/usr/bin/env node
/**
 * debugging_extractor.ts
 *
 * 从 debugging 类型会话中萃取核心摘要
 * 遵循 context-chains SKILL.md 的 debugging schema
 */

interface DebuggingSummary {
  session_id: string;
  work_type: 'debugging';
  created_at: string;
  gate_at_session: number;
  '关联上下文': Array<{ session_id: string; reason: string; relevance: number }>;
  '核心摘要': {
    root_cause: string;
    symptoms_observed: string[];
    fix_applied: Array<{
      description: string;
      verification: string;
    }>;
    files_touched: string[];
    introduced_regression_risk: 'low' | 'medium' | 'high';
  };
  '决策缺口': Array<{ 描述: string; 影响: string; 需要什么才能关闭: string }>;
  '风险点': Array<{ 描述: string; 概率: 'high' | 'medium' | 'low'; 缓解措施: string }>;
  '遗迹': string[];
}

function extractRootCause(text: string): string {
  const patterns = [
    /(?:根因|root cause|根本原因|原因是|因为):\s*(.+)/gi,
    /(?:问题出在|issue is|problem is):\s*(.+)/gi,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      return match[1].trim();
    }
  }

  return '';
}

function extractSymptoms(text: string): string[] {
  const symptoms: string[] = [];

  const symptomPattern = /(?:症状|symptom|表现|现象|出现|报错|error):\s*(.+)/gi;
  let match;

  while ((match = symptomPattern.exec(text)) !== null) {
    symptoms.push(match[1].trim());
  }

  return symptoms;
}

function extractFix(text: string): DebuggingSummary['核心摘要']['fix_applied'] {
  const fixes: DebuggingSummary['核心摘要']['fix_applied'] = [];

  const fixPattern = /(?:修复|fix|解决|方案|approach):\s*(.+)/gi;
  let match;

  while ((match = fixPattern.exec(text)) !== null) {
    fixes.push({
      description: match[1].trim(),
      verification: '',
    });
  }

  return fixes;
}

function extractFilesTouched(text: string): string[] {
  const files: string[] = [];

  // Common file patterns in code discussions
  const filePattern = /(?:modified|changed|updated|fixed|编辑|修改):\s*([^\s]+)/gi;
  let match;

  while ((match = filePattern.exec(text)) !== null) {
    files.push(match[1]);
  }

  return [...new Set(files)];
}

function buildSummary(input: {
  sessionId: string;
  gate: number;
  conversationText: string;
  relatedSessions?: Array<{ sessionId: string; reason: string; relevance: number }>;
}): DebuggingSummary {
  return {
    session_id: input.sessionId,
    work_type: 'debugging',
    created_at: new Date().toISOString(),
    gate_at_session: input.gate,
    '关联上下文': input.relatedSessions || [],
    '核心摘要': {
      root_cause: extractRootCause(input.conversationText),
      symptoms_observed: extractSymptoms(input.conversationText),
      fix_applied: extractFix(input.conversationText),
      files_touched: extractFilesTouched(input.conversationText),
      introduced_regression_risk: 'medium',
    },
    '决策缺口': [],
    '风险点': [],
    '遗迹': [],
  };
}

export { buildSummary, type DebuggingSummary };

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
