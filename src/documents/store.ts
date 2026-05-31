/**
 * Document Store - P2P Document Receiving and Storage
 * 接收并存储来自其他 iroh 节点的文档
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

export interface DocumentChunk {
  docId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  chunkIndex: number;
  totalChunks: number;
  content: string;  // Base64 encoded
  fromNodeId: string;
  message?: string;
  timestamp: number;
}

export interface ReceivedDocument {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  fromNodeId: string;
  fromNodeIdShort: string;
  receivedAt: number;
  message?: string;
  path: string;
}

export type DocumentReceivedCallback = (doc: ReceivedDocument) => void;

interface PendingDocument {
  docId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  totalChunks: number;
  receivedChunks: Map<number, string>;  // chunkIndex -> Base64 content
  fromNodeId: string;
  message?: string;
  timestamp: number;
}

export class DocumentStore {
  private baseDir: string;
  private pendingDocs: Map<string, PendingDocument> = new Map();
  private receivedCallback: DocumentReceivedCallback | null = null;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || path.join(process.env.HOME || '/tmp', '.bolloon', 'documents', 'received');
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    await fs.mkdir(path.join(this.baseDir, 'chunks'), { recursive: true });
    console.log('[DocumentStore] Initialized at', this.baseDir);
  }

  onDocumentReceived(callback: DocumentReceivedCallback): void {
    this.receivedCallback = callback;
  }

  async receiveChunk(chunk: DocumentChunk): Promise<ReceivedDocument | null> {
    const { docId, chunkIndex, totalChunks, fileName, fileSize, mimeType, content, fromNodeId, message, timestamp } = chunk;

    // 获取或创建 pending document
    let pending = this.pendingDocs.get(docId);
    if (!pending) {
      pending = {
        docId,
        fileName,
        fileSize,
        mimeType,
        totalChunks,
        receivedChunks: new Map(),
        fromNodeId,
        message,
        timestamp,
      };
      this.pendingDocs.set(docId, pending);
    }

    // 存储分块
    pending.receivedChunks.set(chunkIndex, content);

    // 检查是否收齐
    if (pending.receivedChunks.size >= totalChunks) {
      return this.assembleDocument(docId);
    }

    return null;
  }

  private async assembleDocument(docId: string): Promise<ReceivedDocument | null> {
    const pending = this.pendingDocs.get(docId);
    if (!pending) return null;

    try {
      // 按顺序合并所有分块
      const allContent: number[] = [];
      for (let i = 0; i < pending.totalChunks; i++) {
        const chunkContent = pending.receivedChunks.get(i);
        if (!chunkContent) {
          console.warn(`[DocumentStore] Missing chunk ${i} for doc ${docId}`);
          return null;
        }
        const bytes = Uint8Array.from(atob(chunkContent), c => c.charCodeAt(0));
        allContent.push(...Array.from(bytes));
      }

      // 创建文档目录
      const docDir = path.join(this.baseDir, docId);
      await fs.mkdir(docDir, { recursive: true });

      // 保存文件
      const filePath = path.join(docDir, pending.fileName);
      await fs.writeFile(filePath, Buffer.from(allContent));

      // 保存 manifest
      const manifest = {
        id: docId,
        fileName: pending.fileName,
        fileSize: pending.fileSize,
        mimeType: pending.mimeType,
        fromNodeId: pending.fromNodeId,
        receivedAt: Date.now(),
        message: pending.message,
      };
      await fs.writeFile(path.join(docDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

      // 更新索引
      await this.updateIndex(manifest);

      // 清理 pending
      this.pendingDocs.delete(docId);

      const receivedDoc: ReceivedDocument = {
        ...manifest,
        fromNodeIdShort: pending.fromNodeId.substring(0, 16) + '...',
        path: filePath,
      };

      // 触发回调
      if (this.receivedCallback) {
        this.receivedCallback(receivedDoc);
      }

      console.log(`[DocumentStore] Document assembled: ${pending.fileName} (${pending.fileSize} bytes)`);
      return receivedDoc;
    } catch (e) {
      console.error('[DocumentStore] Failed to assemble document:', e);
      this.pendingDocs.delete(docId);
      return null;
    }
  }

  private async updateIndex(manifest: any): Promise<void> {
    const indexPath = path.join(this.baseDir, 'index.json');
    let index: any[] = [];

    try {
      const existing = await fs.readFile(indexPath, 'utf-8');
      index = JSON.parse(existing);
    } catch {
      // Index doesn't exist yet
    }

    // 添加新文档
    index.unshift(manifest);  // newest first

    // 只保留最近 100 条
    if (index.length > 100) {
      index = index.slice(0, 100);
    }

    await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
  }

  async getReceivedDocuments(limit: number = 50, senderPeerId?: string): Promise<ReceivedDocument[]> {
    const indexPath = path.join(this.baseDir, 'index.json');

    try {
      const data = await fs.readFile(indexPath, 'utf-8');
      let docs: any[] = JSON.parse(data);

      if (senderPeerId) {
        docs = docs.filter(d => d.fromNodeId === senderPeerId);
      }

      return docs.slice(0, limit).map(doc => ({
        ...doc,
        fromNodeIdShort: doc.fromNodeId.substring(0, 16) + '...',
        path: path.join(this.baseDir, doc.id, doc.fileName),
      }));
    } catch {
      return [];
    }
  }

  async readDocument(docId: string): Promise<{ content: string; metadata: ReceivedDocument } | null> {
    const docDir = path.join(this.baseDir, docId);
    const manifestPath = path.join(docDir, 'manifest.json');
    const filePath = path.join(docDir);

    try {
      const manifestData = await fs.readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(manifestData);
      const fileContent = await fs.readFile(filePath, 'utf-8');

      return {
        content: fileContent,
        metadata: {
          ...manifest,
          fromNodeIdShort: manifest.fromNodeId.substring(0, 16) + '...',
          path: filePath,
        },
      };
    } catch {
      return null;
    }
  }

  async deleteDocument(docId: string): Promise<boolean> {
    const docDir = path.join(this.baseDir, docId);

    try {
      await fs.rm(docDir, { recursive: true });

      // 更新索引
      const indexPath = path.join(this.baseDir, 'index.json');
      try {
        const data = await fs.readFile(indexPath, 'utf-8');
        let index: any[] = JSON.parse(data);
        index = index.filter(d => d.id !== docId);
        await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
      } catch {
        // Index doesn't exist
      }

      return true;
    } catch {
      return false;
    }
  }
}

export const documentStore = new DocumentStore();