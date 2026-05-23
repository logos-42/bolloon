#!/usr/bin/env node
/**
 * question_extractor.ts
 *
 * 从 question 类型会话中萃取核心摘要
 * 遵循 context-chains SKILL.md 的 question schema
 */

interface QuestionSummary {
  session_id: string;
  work_type: 'question';
  created_at: string;
  gate_at_session: number;
  '关联上下文': Array<{ session_id: string; reason: string; relevance: number }>;
  '核心摘要': {
    question_type: 'concept' | 'implementation' | 'debugging' | 'tool_usage' | 'unknown';
    answer_summary: string;
    source: string;
    related_context: Array<{
      session_id: string;
      relevance: number;
    }>;
  };
  '决策缺口': Array<{ 描述: string; 影响: string; 需要什么才能关闭: string }>;
  '遗迹': string[];
}

function extractQuestionType(text: string): QuestionSummary['核心摘要']['question_type'] {
  const lower = text.toLowerCase();

  if (lower.includes('concept') || lower.includes('概念') || lower.includes('原理')) {
    return 'concept';
  }
  if (lower.includes('implement') || lower.includes('实现') || lower.includes('怎么写')) {
    return 'implementation';
  }
  if (lower.includes('debug') || lower.includes('调试') || lower.includes('报错')) {
    return 'debugging';
  }
  if (lower.includes('tool') || lower.includes('命令') || lower.includes('怎么用')) {
    return 'tool_usage';
  }

  return 'unknown';
}

function extractAnswer(text: string): string {
  // Look for answer patterns
  const answerPatterns = [
    /(?:答案是|answer is|正确答案是|应该是):\s*(.+)/gi,
    /(?:总结|summary|结论|conclusion):\s*(.+)/gi,
  ];

  for (const pattern of answerPatterns) {
    const match = pattern.exec(text);
    if (match) {
      return match[1].trim();
    }
  }

  return '';
}

function extractSource(text: string): string {
  const sourcePatterns = [
    /(?:来自|from|来源|source):\s*(.+)/gi,
    /(?:文档|doc|文档说明):\s*(.+)/gi,
    /(?:代码|code):\s*(.+)/gi,
  ];

  for (const pattern of sourcePatterns) {
    const match = pattern.exec(text);
    if (match) {
      return match[1].trim();
    }
  }

  return '';
}

function buildSummary(input: {
  sessionId: string;
  gate: number;
  conversationText: string;
  relatedSessions?: Array<{ sessionId: string; reason: string; relevance: number }>;
}): QuestionSummary {
  return {
    session_id: input.sessionId,
    work_type: 'question',
    created_at: new Date().toISOString(),
    gate_at_session: input.gate,
    '关联上下文': input.relatedSessions || [],
    '核心摘要': {
      question_type: extractQuestionType(input.conversationText),
      answer_summary: extractAnswer(input.conversationText),
      source: extractSource(input.conversationText),
      related_context: [],
    },
    '决策缺口': [],
    '遗迹': [],
  };
}

export { buildSummary, type QuestionSummary };

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
