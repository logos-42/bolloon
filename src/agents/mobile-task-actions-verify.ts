/**
 * mobile-task-actions-verify.ts — 桌面端**验签**实现 (2026-09-25)
 *
 * 与 `contacts/grants.ts::verifyGrantSignature` 同一套纪律 (同一批已登记设备公钥, 同样逐项给理由):
 *   形状 → 设备已登记 → payloadHash 对得上 → Ed25519 真验签 → 时效 → 内容摘要对得上。
 *
 * 为什么内容摘要要**桌面重算**: 手机签的是 "kind + 规范化内容" 的摘要。桌面在执行前用**请求里的原始字段**
 * 重算一遍, 于是签名天然绑定了"要执行的那件事"本身 —— 既不能换类型 (入群签名拿去发公告),
 * 也不能换内容 (换群/换正文/换公告号)。
 *
 * node 侧实现 (crypto.verify) 与手机 WebCrypto 签名对得上, 因为**规范载荷用的是同一份纯函数**。
 */

import * as crypto from 'crypto';
import type { DeviceKey } from './contacts/grants.js';
import {
  canonicalTaskActionPayload, taskActionContentText, checkTaskActionShape, checkTaskActionFreshness,
  actionKindAllowsRequest, TASK_ACTION_TTL_MS,
  type SignedTaskAction, type SignableTaskAction, type TaskActionRequest,
} from './mobile-task-actions.js';

/** sha256(规范化动作内容) —— 与手机侧 crypto.subtle.digest('SHA-256', …) 同值 */
export function contentDigestOf(req: TaskActionRequest): string {
  return crypto.createHash('sha256').update(taskActionContentText(req), 'utf8').digest('hex');
}

/** sha256(规范载荷) —— 与手机侧 payloadHash 同值 */
export function payloadHashOf(a: SignableTaskAction): string {
  return crypto.createHash('sha256').update(canonicalTaskActionPayload(a), 'utf8').digest('hex');
}

export type TaskActionVerifyReason =
  | 'missing_action' | 'bad_action_id' | 'unknown_kind' | 'bad_device_id' | 'bad_content_digest' | 'bad_via' | 'bad_time'
  | 'unsigned' | 'unknown_device' | 'device_mismatch' | 'payload_tampered' | 'bad_signature' | 'verify_error'
  | 'expired' | 'not_yet_valid' | 'ttl_too_long'
  | 'content_mismatch' | 'kind_mismatch' | 'kind_shape_mismatch' | 'request_kind_mismatch';

export interface TaskActionVerifyResult { ok: boolean; reason?: TaskActionVerifyReason; message?: string; action?: SignableTaskAction }

/**
 * 完整验签 (桌面路由唯一入口)。
 *
 * @param input   手机请求里的 { action, signature }
 * @param pub     已登记设备公钥 (按 action.deviceId 查; 查不到传 null)
 * @param opts.req      桌面准备执行的业务字段 → 重算内容摘要比对 (不传 = 跳过内容比对, 只有明确不需要时才这样用)
 * @param opts.now      当前时间 (测试注入)
 */
export function verifyTaskAction(
  input: SignedTaskAction | null | undefined,
  pub: DeviceKey | null | undefined,
  opts: { req?: TaskActionRequest | null; now?: number } = {},
): TaskActionVerifyResult {
  const shape = checkTaskActionShape(input);
  if (!shape.ok) return { ok: false, reason: shape.reason as TaskActionVerifyReason, message: `动作载荷形状不合法: ${shape.reason}` };
  const action = shape.action;
  const signature = (input as SignedTaskAction)?.signature;
  if (!signature || !signature.sig) return { ok: false, reason: 'unsigned', message: '动作没有签名 (桌面拒收未签名的手机动作)' };
  if (!pub) return { ok: false, reason: 'unknown_device', message: `未知设备 ${action.deviceId} (先在桌面登记这台手机的公钥)` };
  if (pub.deviceId !== action.deviceId || signature.deviceId !== action.deviceId) {
    return { ok: false, reason: 'device_mismatch', message: '签名设备与载荷设备不一致' };
  }
  if (signature.alg !== 'ed25519') return { ok: false, reason: 'bad_signature', message: `签名算法不是 ed25519: ${String((signature as any).alg)}` };
  const payload = canonicalTaskActionPayload(action);
  if (signature.payloadHash && signature.payloadHash !== payloadHashOf(action)) {
    return { ok: false, reason: 'payload_tampered', message: '载荷哈希对不上 (动作在签名后被改过)' };
  }
  try {
    const ok = crypto.verify(null, Buffer.from(payload, 'utf8'), crypto.createPublicKey(String(pub.publicKeyPem)), Buffer.from(String(signature.sig), 'base64'));
    if (!ok) return { ok: false, reason: 'bad_signature', message: '设备签名验不过 (不是这台设备签的, 或载荷被改过)' };
  } catch (err: any) {
    return { ok: false, reason: 'verify_error', message: `验签抛出: ${String(err?.message || err).slice(0, 120)}` };
  }
  const fresh = checkTaskActionFreshness(action, opts.now ?? Date.now());
  if (!fresh.ok) return { ok: false, reason: fresh.reason as TaskActionVerifyReason, message: `动作时效不合法: ${fresh.reason} (TTL 上限 ${TASK_ACTION_TTL_MS / 60000} 分钟)` };

  if (opts.req) {
    if (String(opts.req.kind) !== action.kind) {
      return { ok: false, reason: 'kind_mismatch', message: `请求类型 (${opts.req.kind}) 与签名动作类型 (${action.kind}) 不一致` };
    }
    const kindOk = actionKindAllowsRequest(action.kind, opts.req);
    if (!kindOk.ok) return { ok: false, reason: 'kind_shape_mismatch', message: kindOk.error || '动作类型与请求字段不匹配' };
    const expect = contentDigestOf(opts.req);
    if (expect !== action.contentDigest) {
      return { ok: false, reason: 'content_mismatch', message: '内容摘要对不上: 签名绑定的不是你这次要执行的内容' };
    }
  }
  return { ok: true, action };
}
