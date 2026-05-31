/**
 * P2P Document Tools - Tools for sending/receiving documents over iroh P2P
 */

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
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
    'pdf': 'application/pdf',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return mimeTypes[ext || ''] || 'application/octet-stream';
}

export async function initDocumentReceiver(): Promise<void> {
  await documentStore.initialize();

  documentStore.onDocumentReceived((doc) => {
    console.log(`[DocumentReceiver] Document received: ${doc.fileName} from ${doc.fromNodeIdShort}`);
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