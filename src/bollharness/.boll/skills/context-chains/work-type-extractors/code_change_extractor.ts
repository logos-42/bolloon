#!/usr/bin/env node
/**
 * code_change_extractor.ts
 *
 * 从 code_change 类型会话中萃取核心摘要
 * 遵循 context-chains SKILL.md 的 code_change schema
 */

interface CodeChangeSummary {
  session_id: string;
  work_type: 'code_change';
  created_at: string;
  gate_at_session: number;
  '关联上下文': Array<{
    session_id: string;
    reason: string;
    relevance: number;
  }>;
  '核心摘要': {
    files_changed: Array<{
      path: string;
      change_type: 'modify' | 'add' | 'delete';
      reason: string;
      seam_affected: boolean;
    }>;
    decisions: Array<{
      choice: string;
      reason: string;
    }>;
    adr_linked: string[];
  };
  '决策缺口': Array<{
    描述: string;
    影响: string;
    需要什么才能关闭: string;
  }>;
  '风险点': Array<{
    描述: string;
    概率: 'high' | 'medium' | 'low';
    缓解措施: string;
  }>;
  '遗迹': string[];
}

function extractFilesChanged(conversationText: string): CodeChangeSummary['核心摘要']['files_changed'] {
  const files: CodeChangeSummary['核心摘要']['files_changed'] = [];

  // 从 git diff 或文件列表中提取
  const diffPattern = /^[+-]{3}\s+(?:a\/)?(.+)|^(?:modified|new file|deleted):\s+(.+)/gm;
  let match;

  while ((match = diffPattern.exec(conversationText)) !== null) {
    const path = match[1] || match[2];
    if (path && !path.includes('diff --git')) {
      const changeType = match[0].startsWith('-')
        ? 'delete'
        : match[0].startsWith('+')
          ? 'add'
          : 'modify';

      files.push({
        path,
        change_type: changeType,
        reason: '', // 需要从上下文推断
        seam_affected: false, // 需要从接缝分析得出
      });
    }
  }

  return files;
}

function extractDecisions(conversationText: string): CodeChangeSummary['核心摘要']['decisions'] {
  const decisions: CodeChangeSummary['核心摘要']['decisions'] = [];

  // 识别决策关键词
  const decisionPatterns = [
    /(?:决定|选择|采用|使用|选|Chose|Selected|Using)\s+(.+?)\s+(?:而非|instead of|rather than|而不是)\s+(.+)/gi,
    /(?:因为|由于|考虑到|Considering|Because)\s+(.+?)，?\s*(?:决定|选择|采用)\s+(.+)/gi,
    /decision:\s*(.+)/gi,
  ];

  // 简化版本：从关键词附近提取
  const decisionKeywords = ['决定', '选择', '采用', '选用', 'Chose', 'Selected', 'Using', 'decision'];

  return decisions;
}

function buildSummary(input: {
  sessionId: string;
  gate: number;
  conversationText: string;
  relatedSessions?: Array<{ sessionId: string; reason: string; relevance: number }>;
}): CodeChangeSummary {
  const files = extractFilesChanged(input.conversationText);
  const decisions = extractDecisions(input.conversationText);

  return {
    session_id: input.sessionId,
    work_type: 'code_change',
    created_at: new Date().toISOString(),
    gate_at_session: input.gate,
    '关联上下文': input.relatedSessions || [],
    '核心摘要': {
      files_changed: files,
      decisions,
      adr_linked: [],
    },
    '决策缺口': [],
    '风险点': [],
    '遗迹': [],
  };
}

export { buildSummary, type CodeChangeSummary };

// CLI 用法
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: code_change_extractor.ts <session_id> <gate> [conversation_file]');
    process.exit(1);
  }

  const [sessionId, gate] = args;
  let conversationText = '';

  if (args[2]) {
    const fs = require('fs');
    conversationText = fs.readFileSync(args[2], 'utf-8');
  } else {
    conversationText = require('fs').readFileSync('/dev/stdin', 'utf-8');
  }

  const summary = buildSummary({
    sessionId,
    gate: parseInt(gate, 10),
    conversationText,
  });

  console.log(JSON.stringify(summary, null, 2));
}
