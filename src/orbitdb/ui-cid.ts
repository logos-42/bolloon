/**
 * ui-cid.ts — UI 组件 CID 化层 (2026-08-06)
 *
 * 让 UI 组件也可以内容寻址:
 *   - saveComponent: 组件定义 (代码 + props schema + theme) → CIDDatabase (type: 'ui')
 *   - loadComponent: 按 CID 加载组件定义
 *   - versionComponent: 组件版本管理 (复用 CIDDatabase.update 版本链)
 *   - loadReactComponent: 从 CID 拉组件代码 → React 组件 (动态渲染)
 *
 * 架构: UI 组件 → UICidStore → CIDDatabase → OrbitDB/CID → IPFS
 * 注: npm 无标准 "UI CID" 库, 按用户减法哲学自研轻量层 (数据层 node 通用,
 *     浏览器渲染集成点留给 Web client)。
 */

import React from 'react';
import {
  getCIDDatabase,
  type CIDDatabase,
  type CIDRecord,
} from './cid-database.js';

export type UIFramework = 'react' | 'vanilla';

export interface UIComponentDef {
  name: string;
  /** 组件代码: React 函数组件源码 (function Component(props){...}) 或 vanilla 渲染函数 */
  code: string;
  framework: UIFramework;
  propsSchema?: Record<string, unknown>;
  theme?: Record<string, string>;
  description?: string;
}

export interface UICidStore {
  saveComponent(agentId: string, def: UIComponentDef): Promise<CIDRecord>;
  loadComponent(cid: string): Promise<UIComponentDef | null>;
  listComponents(agentId?: string): Promise<CIDRecord[]>;
  versionComponent(cid: string, code: string, extra?: Partial<UIComponentDef>): Promise<CIDRecord | null>;
  /** 动态加载: CID → React 组件 (code 必须是有效 React 函数组件源码) */
  loadReactComponent(cid: string): Promise<{ component: React.ComponentType<any>; def: UIComponentDef }>;
}

export class UICidStoreImpl implements UICidStore {
  constructor(private db: CIDDatabase = getCIDDatabase()) {}

  async saveComponent(agentId: string, def: UIComponentDef): Promise<CIDRecord> {
    return this.db.save({
      agentId,
      type: 'ui',
      content: def,
      metadata: { kind: 'ui-component', framework: def.framework },
    });
  }

  async loadComponent(cid: string): Promise<UIComponentDef | null> {
    const rec = await this.db.load(cid);
    if (!rec) return null;
    return rec.content as UIComponentDef;
  }

  async listComponents(agentId?: string): Promise<CIDRecord[]> {
    return this.db.list(agentId ? { agentId, type: 'ui' } : { type: 'ui' });
  }

  async versionComponent(cid: string, code: string, extra?: Partial<UIComponentDef>): Promise<CIDRecord | null> {
    const old = await this.loadComponent(cid);
    if (!old) return null;
    return this.db.update(cid, {
      ...old,
      ...extra,
      code,
    });
  }

  async loadReactComponent(cid: string): Promise<{ component: React.ComponentType<any>; def: UIComponentDef }> {
    const def = await this.loadComponent(cid);
    if (!def) throw new Error(`组件不存在: ${cid}`);
    if (def.framework !== 'react') throw new Error(`不是 React 组件: ${def.framework}`);
    // 动态构造: code 是函数组件源码 → new Function 编译 (受限环境: 无 module 作用域)
    const factory = new Function('React', `return (${def.code})`) as (r: typeof React) => React.ComponentType<any>;
    const component = factory(React);
    if (typeof component !== 'function') throw new Error('组件代码必须返回 React 组件函数');
    return { component, def };
  }
}

/** 单例 */
let _uiStore: UICidStore | null = null;
export function getUICidStore(): UICidStore {
  if (!_uiStore) _uiStore = new UICidStoreImpl();
  return _uiStore;
}
