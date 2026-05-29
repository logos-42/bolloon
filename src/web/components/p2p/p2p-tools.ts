/**
 * P2P 工具调用模块
 * 支持文件和本地信息的 P2P 传递
 */

import type { P2PToolRequest, FileInfo, CIDResolveResult } from './types.js';

// 工具类型枚举
export enum P2PToolType {
  FILE_TRANSFER = 'file_transfer',
  LOCAL_INFO = 'local_info',
  SYSTEM_INFO = 'system_info',
  FILE_LIST = 'file_list'
}

// 系统信息接口
export interface SystemInfo {
  platform: string;
  arch: string;
  nodeVersion: string;
  memory: { total: number; free: number; used: number };
  cpu: { cores: number; model: string };
  uptime: number;
}

// 本地信息类型
export type InfoQueryType = 'os' | 'cpu' | 'memory' | 'disk' | 'uptime';

// 文件列表项
export interface FileListItem {
  name: string;
  size: number;
  isDirectory: boolean;
  modified: string;
}

// 文件列表结果
export interface FileListResult {
  success: boolean;
  path: string;
  files?: FileListItem[];
  error?: string;
}

// 工具执行结果
export interface ToolExecutionResult {
  success: boolean;
  data?: any;
  error?: string;
  messageId?: string;
}

// 文件传输
export async function transferFile(
  targetDid: string,
  fileInfo: FileInfo,
  messageId?: string
): Promise<ToolExecutionResult> {
  try {
    const payload = {
      type: 'file',
      tool: P2PToolType.FILE_TRANSFER,
      data: {
        name: fileInfo.name,
        size: fileInfo.size,
        mimeType: fileInfo.mimeType,
        content: fileInfo.content
      }
    };

    const res = await fetch('/api/message-p2p', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetDid,
        content: JSON.stringify(payload),
        type: 'file'
      })
    });

    if (res.ok) {
      const data = await res.json();
      return {
        success: true,
        messageId: data.messageId || messageId
      };
    } else {
      return { success: false, error: '文件传输失败' };
    }
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

// 本地信息查询
export async function queryLocalInfo(
  targetDid: string,
  query: InfoQueryType
): Promise<ToolExecutionResult> {
  try {
    const payload = {
      type: 'info_query',
      tool: P2PToolType.LOCAL_INFO,
      query: query
    };

    const res = await fetch('/api/message-p2p', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetDid,
        content: JSON.stringify(payload),
        type: 'ai-dialogue'
      })
    });

    if (res.ok) {
      const data = await res.json();
      return {
        success: true,
        data: data.response,
        messageId: data.messageId
      };
    } else {
      return { success: false, error: '信息查询失败' };
    }
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

// 系统信息请求
export async function getSystemInfo(targetDid: string): Promise<ToolExecutionResult> {
  try {
    const payload = {
      type: 'system_info_request',
      tool: P2PToolType.SYSTEM_INFO
    };

    const res = await fetch('/api/message-p2p', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetDid,
        content: JSON.stringify(payload),
        type: 'ai-dialogue'
      })
    });

    if (res.ok) {
      const data = await res.json();
      return {
        success: true,
        data: data.response,
        messageId: data.messageId
      };
    } else {
      return { success: false, error: '系统信息获取失败' };
    }
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

// 文件列表请求
export async function listFiles(
  targetDid: string,
  path: string = '/'
): Promise<ToolExecutionResult> {
  try {
    const payload = {
      type: 'file_list_request',
      tool: P2PToolType.FILE_LIST,
      path: path
    };

    const res = await fetch('/api/message-p2p', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetDid,
        content: JSON.stringify(payload),
        type: 'ai-dialogue'
      })
    });

    if (res.ok) {
      const data = await res.json();
      return {
        success: true,
        data: data.response,
        messageId: data.messageId
      };
    } else {
      return { success: false, error: '文件列表获取失败' };
    }
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

// 工具调用入口
export async function executeP2PTool(request: P2PToolRequest): Promise<ToolExecutionResult> {
  const { toolName, payload, targetDid } = request;

  if (!targetDid) {
    return { success: false, error: '未指定目标节点' };
  }

  switch (toolName) {
    case P2PToolType.FILE_TRANSFER:
      return transferFile(targetDid, payload.data as FileInfo);

    case P2PToolType.LOCAL_INFO:
      return queryLocalInfo(targetDid, payload.data as InfoQueryType);

    case P2PToolType.SYSTEM_INFO:
      return getSystemInfo(targetDid);

    case P2PToolType.FILE_LIST:
      return listFiles(targetDid, (payload.data as any)?.path || '/');

    default:
      return { success: false, error: `未知工具: ${toolName}` };
  }
}

// 本地系统信息获取 (用于响应来自远程的请求)
export function getLocalSystemInfo(): SystemInfo {
  const memUsage = process.memoryUsage();
  const cpuCores = require('os').cpus();

  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    memory: {
      total: memUsage.heapTotal,
      free: memUsage.heapFree,
      used: memUsage.heapUsed
    },
    cpu: {
      cores: cpuCores.length,
      model: cpuCores[0]?.model || 'Unknown'
    },
    uptime: process.uptime()
  };
}

// 本地文件列表 (用于响应来自远程的请求)
export function getLocalFileList(dirPath: string): FileListResult {
  try {
    const fs = require('fs');
    const path = require('path');

    const fullPath = path.resolve(dirPath);
    const files = fs.readdirSync(fullPath);

    const fileList: FileListItem[] = files.map((name: string) => {
      const fullFilePath = path.join(fullPath, name);
      let stat;
      try {
        stat = fs.statSync(fullFilePath);
      } catch {
        return null;
      }

      return {
        name: name,
        size: stat.size,
        isDirectory: stat.isDirectory(),
        modified: stat.mtime.toISOString()
      };
    }).filter(Boolean);

    return {
      success: true,
      path: fullPath,
      files: fileList
    };
  } catch (e) {
    return {
      success: false,
      path: dirPath,
      error: (e as Error).message
    };
  }
}

// 导出工具名称列表
export const P2P_TOOLS = [
  {
    name: P2PToolType.FILE_TRANSFER,
    description: '传输文件到远程节点',
    parameters: ['targetDid', 'fileInfo']
  },
  {
    name: P2PToolType.LOCAL_INFO,
    description: '查询远程节点本地信息',
    parameters: ['targetDid', 'query']
  },
  {
    name: P2PToolType.SYSTEM_INFO,
    description: '获取远程节点系统信息',
    parameters: ['targetDid']
  },
  {
    name: P2PToolType.FILE_LIST,
    description: '列出远程节点目录文件',
    parameters: ['targetDid', 'path']
  }
];

console.log('[P2P Tools] 工具模块已加载');