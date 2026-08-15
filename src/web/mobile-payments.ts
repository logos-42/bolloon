/**
 * mobile-payments.ts — 手机端支付审批 (2026-08-15)
 *
 * 独立能力: 支付审批 (与数据同步 / agent 功能并列, 但不属于任一层).
 * 存储: IndexedDB (独立库, 与 data/agent 分开).
 */

export interface Approval {
  id: string;
  service: string;
  amount: number;
  recipient: string;
  reason: string;
  retryPayload?: any;
  createdAt: number;
  resolved?: boolean;
  resolvedAt?: number;
  approved?: boolean;
}

const DB_NAME = 'bolloon-mobile-payments';
let _db: IDBDatabase | null = null;

function openDb(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => { _db = req.result; resolve(_db!); };
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key: string): Promise<any> {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction('kv', 'readonly');
    const r = tx.objectStore('kv').get(key);
    r.onsuccess = () => resolve(r.result ?? null);
    r.onerror = () => resolve(null);
  });
}

async function idbSet(key: string, val: any): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadApprovals(): Promise<Approval[]> {
  return (await idbGet('approvals')) || [];
}

async function saveApprovals(list: Approval[]): Promise<void> {
  await idbSet('approvals', list);
}

export async function addApproval(a: Approval): Promise<void> {
  const all = await loadApprovals();
  all.push(a);
  await saveApprovals(all);
}

export async function approveApproval(id: string, approved: boolean): Promise<void> {
  const all = await loadApprovals();
  const a = all.find((x) => x.id === id);
  if (a) {
    a.resolved = true;
    a.resolvedAt = Date.now();
    a.approved = approved;
    await saveApprovals(all);
  }
}

/** 测试用: 关闭并清空支付库 */
export async function resetPaymentsDb(): Promise<void> {
  if (_db) {
    _db.close();
    _db = null;
  }
  await new Promise<void>((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

export default { loadApprovals, addApproval, approveApproval };