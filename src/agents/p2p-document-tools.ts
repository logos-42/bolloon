/**
 * P2P Document Tools - Tools for sending/receiving documents over iroh P2P
 */

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { irohTransport } from '../network/iroh-transport.js';
import { documentReader, type DocumentContent } from '../documents/reader.js';
import { documentStore, type DocumentChunk, type ReceivedDocument } from '../documents/store.js';
import type { Tool } from './pi-sdk.js';

const CHUNK_SIZE = 60 * 1024;  // 60KB per chunk

function generateDocId(): string {
  return crypto.randomUUID();
}

function getMimeType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop();
  const mimeTypes: Record<string, string> = {
    'txt': 'text/plain',
    'md': 'text/markdown',
    'html': 'text/html',
    'htm': 'text/html',
    'yaml': 'application/yaml',
    'yml': 'application/yaml',
    'json': 'application/json',
    'pdf': 'application/pdf',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return mimeTypes[ext || ''] || 'application/octet-stream';
}

export async function initDocumentReceiver(): Promise<void> {
  await documentStore.initialize();

  documentStore.onDocumentReceived(async (doc) => {
    console.log(`[DocumentReceiver] Document received: ${doc.fileName} from ${doc.fromNodeIdShort}`);
    // 异步调用 LLM 解析（不阻塞接收流程）
    void parseDocumentWithLLM(doc);
  });

  irohTransport.onMessage('document_chunk', async (msg) => {
    try {
      const chunk: DocumentChunk = JSON.parse(new TextDecoder().decode(msg.payload));
      const result = await documentStore.receiveChunk(chunk);
      if (result) {
        console.log(`[DocumentReceiver] Document complete: ${result.fileName}`);
      }
    } catch (e) {
      console.error('[DocumentReceiver] Failed to process chunk:', e);
    }
  });

  console.log('[DocumentReceiver] Initialized and listening for document chunks');
}

// ============================================================================
// AI 解析反馈：接收方解析完文档后把摘要回送给发送方
// ============================================================================

export interface AIFeedbackMessage {
  docId: string;
  fileName: string;
  mimeType: string;
  summary: string;
  qualityScore: number;
  feedbackAt: number;
  fromNodeId: string;
}

export type AIFeedbackHandler = (feedback: AIFeedbackMessage, fromNodeId: string) => void;
const feedbackHandlers: Set<AIFeedbackHandler> = new Set();

/** 注册 AI 解析反馈监听器（发送方调用） */
export function onAIFeedback(handler: AIFeedbackHandler): void {
  feedbackHandlers.add(handler);
  // iroh listener 只挂一次
  ensureFeedbackListenerInstalled();
}

let feedbackListenerInstalled = false;
function ensureFeedbackListenerInstalled(): void {
  if (feedbackListenerInstalled) return;
  feedbackListenerInstalled = true;
  irohTransport.onMessage('ai_feedback', (msg) => {
    try {
      const fb: AIFeedbackMessage = JSON.parse(new TextDecoder().decode(msg.payload));
      for (const h of feedbackHandlers) {
        try {
          h(fb, msg.from);
        } catch (e) {
          console.error('[AIFeedback] handler error:', e);
        }
      }
    } catch (e) {
      console.error('[AIFeedback] failed to parse message:', e);
    }
  });
}

async function parseDocumentWithLLM(doc: ReceivedDocument): Promise<void> {
  // 没有配 API key 就跳过（保持向后兼容）
  const apiKey = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.MINIMAX_API_KEY || process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log(`[DocumentReceiver] No LLM API key set, skip AI parse for ${doc.fileName}`);
    return;
  }
  try {
    const filePath = path.join(
      process.env.HOME || '/tmp',
      '.bolloon', 'documents', 'received',
      doc.id, doc.fileName
    );
    const content = await fs.readFile(filePath, 'utf-8');
    // 限制长度，避免超 token
    const truncated = content.length > 6000 ? content.substring(0, 6000) + '...[截断]' : content;
    const { getMinimax } = await import('../constraints/index.js');
    const llm = getMinimax();
    const prompt = `请分析以下 ${doc.mimeType} 文档，并给出 (1) 一句话中文摘要 (2) 关键要点列表 (3) 文档质量评分(0-1)。\n\n文件名: ${doc.fileName}\n\n内容:\n${truncated}`;
    const r = await llm.summarize(prompt);
    const sidecar = {
      filename: doc.fileName,
      mimeType: doc.mimeType,
      fromNodeId: doc.fromNodeId,
      receivedAt: doc.receivedAt,
      summary: r.summary,
      qualityScore: r.qualityScore,
      analyzedAt: Date.now(),
    };
    const sidecarPath = path.join(
      process.env.HOME || '/tmp',
      '.bolloon', 'documents', 'received',
      doc.id, 'ai-analysis.json'
    );
    await fs.writeFile(sidecarPath, JSON.stringify(sidecar, null, 2));
    console.log(`[DocumentReceiver] AI parsed ${doc.fileName} (score=${r.qualityScore.toFixed(2)})`);

    // 把 AI 解析结果回送给发送方 (doc.fromNodeId)，形成 "接收 → 解析 → 反馈" 闭环
    if (doc.fromNodeId) {
      const feedback: AIFeedbackMessage = {
        docId: doc.id,
        fileName: doc.fileName,
        mimeType: doc.mimeType,
        summary: r.summary,
        qualityScore: r.qualityScore,
        feedbackAt: Date.now(),
        fromNodeId: irohTransport.getNodeId() || '',
      };
      const sent = await irohTransport.sendMessage(
        doc.fromNodeId,
        'ai_feedback',
        new TextEncoder().encode(JSON.stringify(feedback))
      );
      if (sent) {
        console.log(`[DocumentReceiver] Feedback sent to ${doc.fromNodeIdShort}`);
      } else {
        console.warn(`[DocumentReceiver] Failed to send feedback to ${doc.fromNodeIdShort}`);
      }
    }
  } catch (e) {
    console.error(`[DocumentReceiver] AI parse failed for ${doc.fileName}:`, e);
  }
}

export const p2pDocumentTools: Tool[] = [
  {
    name: 'list_online_peers',
    description: '列出当前通过 iroh P2P 网络在线的对等节点',
    parameters: {},
    execute: async () => {
      try {
        const peers = irohTransport.getConnectedPeers();
        if (peers.length === 0) {
          return { success: true, output: '当前无在线的对等节点' };
        }
        return {
          success: true,
          output: `在线节点 (${peers.length}):\n${peers.map(p => `  - ${p.substring(0, 16)}...`).join('\n')}`
        };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }
  },

  {
    name: 'send_document',
    description: '读取本地文档并发送给指定的对等节点，支持 .txt, .md, .pdf, .docx 格式',
    parameters: {
      target_peer_id: '目标对等节点的完整 nodeId',
      file_path: '要发送的本地文件路径',
      message: '可选的附言消息'
    },
    execute: async (args) => {
      try {
        const { target_peer_id, file_path, message } = args;

        // 读取文档
        let content: DocumentContent;
        try {
          content = await documentReader.read(file_path);
        } catch (e) {
          return { success: false, error: `无法读取文件: ${e}` };
        }

        // 分块
        const mimeType = getMimeType(file_path);
        const fileData = await fs.readFile(file_path);
        const contentBase64 = fileData.toString('base64');
        const totalChunks = Math.ceil(contentBase64.length / CHUNK_SIZE);

        const docId = generateDocId();

        // 逐块发送
        for (let i = 0; i < totalChunks; i++) {
          const chunk: DocumentChunk = {
            docId,
            fileName: content.metadata.filename,
            fileSize: content.metadata.size,
            mimeType,
            chunkIndex: i,
            totalChunks,
            content: contentBase64.substring(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
            fromNodeId: irohTransport.getNodeId() || '',
            message: i === 0 ? message : undefined,
            timestamp: Date.now(),
          };

          const sent = await irohTransport.sendMessage(
            target_peer_id,
            'document_chunk',
            new TextEncoder().encode(JSON.stringify(chunk))
          );

          if (!sent) {
            return { success: false, error: `发送第 ${i + 1}/${totalChunks} 块失败` };
          }
        }

        return {
          success: true,
          output: `📤 文档已发送: ${content.metadata.filename}\n大小: ${content.metadata.size} 字节\n分块: ${totalChunks}\n目标: ${target_peer_id.substring(0, 16)}...`
        };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }
  },

  {
    name: 'receive_documents',
    description: '列出已接收到的文档，可按发送者筛选',
    parameters: {
      limit: '返回数量上限，默认 50',
      sender_peer_id: '可选，按发送者 nodeId 筛选'
    },
    execute: async (args) => {
      try {
        const limit = parseInt(args.limit) || 50;
        const docs = await documentStore.getReceivedDocuments(limit, args.sender_peer_id);

        if (docs.length === 0) {
          return { success: true, output: '暂无已接收的文档' };
        }

        const list = docs.map(d =>
          `📄 ${d.fileName}\n   ID: ${d.id}\n   大小: ${d.fileSize} 字节\n   来自: ${d.fromNodeIdShort}\n   时间: ${new Date(d.receivedAt).toLocaleString()}`
        ).join('\n\n');

        return {
          success: true,
          output: `已接收文档 (${docs.length}):\n\n${list}`
        };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }
  },

  {
    name: 'read_received_document',
    description: '读取已接收文档的内容，返回文档ID可查询文档详情',
    parameters: {
      document_id: '文档ID (从 receive_documents 获取)'
    },
    execute: async (args) => {
      try {
        const { document_id } = args;

        if (!document_id) {
          return { success: false, error: '缺少 document_id 参数' };
        }

        const result = await documentStore.readDocument(document_id);

        if (!result) {
          return { success: false, error: `未找到文档: ${document_id}` };
        }

        const { content, metadata } = result;

        return {
          success: true,
          output: `📄 ${metadata.fileName}\nID: ${metadata.id}\n大小: ${metadata.fileSize} 字节\n来自: ${metadata.fromNodeIdShort}\n\n${content.substring(0, 2000)}${content.length > 2000 ? '...\n(内容已截断)' : ''}`
        };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }
  }
];