import * as fs from 'fs/promises';
import * as path from 'path';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';

export interface DocumentContent {
  text: string;
  metadata: {
    filename: string;
    size: number;
    type: string;
  };
}

export class DocumentReader {
  async read(filePath: string): Promise<DocumentContent> {
    const stats = await fs.stat(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const filename = path.basename(filePath);

    let text: string;

    switch (ext) {
      case '.txt':
      case '.md':
      case '.html':
      case '.htm':
      case '.yaml':
      case '.yml':
      case '.json':
      // M3.5 (2026-06-17): agent 自读源码需要 — 之前 .ts 不支持, LLM 拿到空内容
      //   .ts/.tsx/.js/.jsx 都是纯文本, 直接 readFile
      case '.ts':
      case '.tsx':
      case '.js':
      case '.jsx':
      case '.mjs':
      case '.cjs':
      case '.py':
      case '.go':
      case '.rs':
      case '.java':
      case '.sh':
      case '.bash':
        text = await fs.readFile(filePath, 'utf-8');
        break;
      case '.pdf':
        text = await this.readPdf(filePath);
        break;
      case '.docx':
        text = await this.readDocx(filePath);
        break;
      default:
        throw new Error(`Unsupported file type: ${ext}`);
    }

    return {
      text,
      metadata: {
        filename,
        size: stats.size,
        type: ext
      }
    };
  }

  private async readPdf(filePath: string): Promise<string> {
    const dataBuffer = await fs.readFile(filePath);
    // @ts-ignore - pdf-parse v2 API differs
    const data = await pdfParse(dataBuffer);
    return data.text;
  }

  private async readDocx(filePath: string): Promise<string> {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }

  chunk(text: string, maxChunkSize: number = 4000): string[] {
    const chunks: string[] = [];
    let current = '';

    const sentences = text.split(/(?<=[.!?。！？])\s+/);

    for (const sentence of sentences) {
      if ((current + sentence).length <= maxChunkSize) {
        current += (current ? ' ' : '') + sentence;
      } else {
        if (current) chunks.push(current);
        current = sentence;
      }
    }

    if (current) chunks.push(current);
    return chunks;
  }
}

export const documentReader = new DocumentReader();