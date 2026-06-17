// src/git-transport/chat-types.ts
// 共享类型与常量 — 不依赖任何运行时副作用,可在 import 链路最底层使用.

import * as path from 'path';

export const CHAT_PROTOCOL_VERSION = 1 as const;
export const CHAT_BODY_MAX_BYTES = 256 * 1024; // 256 KiB 单条上限
export const COMMIT_MESSAGE_MAX = 8192; // git commit message 自身 8 KiB 上限
export const CHAT_P2P_NOTIFY_THRESHOLD = 4 * 1024; // > 4 KiB 只走 git, 不发 P2P notify
export const CHAT_DEFAULT_PULL_INTERVAL_MS = 15_000;
export const CHAT_PULL_BACKOFF_MAX_MS = 5 * 60_000;

export interface ChatFrontmatter {
  v: 1;
  from: string; // role, e.g. "default", "nodeA"
  fromPk: string; // 64-hex Ed25519 publicKey, 用于 P2P 校验
  to?: string; // 可选, 缺省 = 广播
  ts: string; // ISO-8601, 同一发送方天然唯一
  // 关联信息: P2P 通道先到的同一条消息的引用, 用于 dedupe
  p2pRef?: string;
  git?: {
    branch?: string;
    sha?: string;
  };
}

export interface ChatMessage {
  filePath: string; // 仓库内绝对或相对路径
  frontmatter: ChatFrontmatter;
  body: string;
  sha: string; // 该文件所属 commit 的 sha
}

export interface ChatOptions {
  repoDir: string; // 仓库根
  remote?: string; // push 目标, 不传则用 origin
  branch?: string; // 默认 master
}

export function chatPaths(repoDir: string) {
  const root = path.join(repoDir, '.comm');
  return {
    root,
    stateDir: path.join(root, '_state'),
    inboxDir: path.join(root, '_inbox'),
    cursorFile: path.join(root, '_state', 'cursor'),
    p2pStatusFile: path.join(root, '_state', 'p2p-status.json'),
    seenFile: path.join(root, '_state', 'seen.json'),
    lockFile: path.join(root, '_state', 'git.lock'),
    remoteFile: path.join(root, 'REMOTE'),
    readmeFile: path.join(root, 'README.md'),
  };
}
