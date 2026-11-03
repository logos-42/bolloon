#!/usr/bin/env node
/**
 * verify-updater-signature.mjs — Tauri 更新包**真验签**门 (2026-11-04)
 *
 * 为什么需要它: 0.7.3–0.7.5 三次发布都没有 `.sig`/签名对不上, 线上清单停在 0.7.0-1,
 * 没有任何门禁发现"链断了"。这个脚本把**客户端那一刻会做的事**在本机重放一遍:
 *   读 latest.json → 下载产物 → 用 tauri.conf 里的 pubkey 验 minisign 签名 → 结论
 *
 * minisign 格式 (Tauri 用的是它):
 *   公钥文件 = base64( "untrusted comment: minisign public key: <16位hex id>\n" + base64(alg(2)|keyid(8)|pk(32)) )
 *   签名文件 = base64( "untrusted comment: ...\n" + base64(alg(2)|keyid(8)|sig(64)) + "trusted comment: ...\n" + base64(globalSig(64)) )
 *   验签 = Ed25519( blake2b512(file) )  (alg="Ed"; 老式 "ED" = 对原文直接签)
 *
 * 用法:
 *   node scripts/verify-updater-signature.mjs --manifest latest.json --pubkey <base64> [--file <本地包>]
 *   node scripts/verify-updater-signature.mjs --manifest <url> --pubkey <base64>   # 直接验线上
 *
 * 退出码: 0 = 全部通过; 1 = 任一项失败 (key id 不匹配 / 验签失败 / 缺字段)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([\w-]+)$/);
    if (m) { a[m[1]] = argv[i + 1]; i++; }
  }
  return a;
}

/** 解析 minisign 公钥 (base64 文本 → alg/keyId/pk) */
export function parsePublicKey(pubkeyB64) {
  const text = Buffer.from(String(pubkeyB64).replace(/\s+/g, ''), 'base64').toString('utf8');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('公钥格式不对: 解出来不足两行');
  if (!/minisign public key/i.test(lines[0])) {
    throw new Error(`公钥格式不对: 首行不是 minisign public key (${lines[0].slice(0, 60)})`);
  }
  const blob = Buffer.from(lines[1], 'base64');
  if (blob.length !== 42) throw new Error(`公钥 blob 长度应为 42, 实际 ${blob.length}`);
  const m = /:\s*([0-9A-Fa-f]{16})\s*$/.exec(lines[0]);
  return {
    alg: blob.subarray(0, 2).toString('latin1'),
    keyId: blob.subarray(2, 10),
    pk: blob.subarray(10, 42),
    idHex: m ? m[1].toUpperCase() : blob.subarray(2, 10).toString('hex').toUpperCase(),
  };
}

/** 解析 minisign 签名 (base64 文本 → alg/keyId/sig/trusted) */
export function parseSignature(sigB64) {
  const text = Buffer.from(String(sigB64).replace(/\s+/g, ''), 'base64').toString('utf8');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('签名格式不对: 解出来不足两行');
  const blob = Buffer.from(lines[1], 'base64');
  if (blob.length !== 74) throw new Error(`签名 blob 长度应为 74, 实际 ${blob.length}`);
  const trusted = lines.find((l) => l.startsWith('trusted comment:')) || '';
  const gsigLine = lines[lines.length - 1];
  const globalSig = trusted && gsigLine !== lines[1] ? Buffer.from(gsigLine, 'base64') : null;
  return {
    alg: blob.subarray(0, 2).toString('latin1'),
    keyId: blob.subarray(2, 10),
    sig: blob.subarray(10, 74),
    trusted,
    globalSig,
  };
}

function ed25519Verify(pk, msg, sig) {
  const der = Buffer.concat([ED25519_SPKI_PREFIX, pk]);
  const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  return crypto.verify(null, msg, key, sig);
}

/** 核心: 验一个文件字节 (返回 {ok, reason}) */
export function verifyBuffer(pub, sig, fileBytes) {
  if (pub.alg !== 'Ed' && pub.alg !== 'ED') {
    return { ok: false, reason: `未知算法 ${JSON.stringify(pub.alg)}` };
  }
  if (!pub.keyId.equals(sig.keyId)) {
    return {
      ok: false,
      reason: `key id 不匹配 (公钥 ${pub.idHex} vs 签名 ${sig.keyId.toString('hex').toUpperCase()}) — 这个包不是这把钥匙签的`,
    };
  }
  // minisign 算法标记语义 (2026-11-04 实测确认, 别按直觉写反):
  //   "ED" = Ed25519 over BLAKE2b-512(文件)  ← Tauri 默认用的就是这个
  //   "Ed" = 对文件原文直接签 (老式)
  const msg =
    sig.alg === 'ED'
      ? crypto.createHash('blake2b512').update(fileBytes).digest()
      : fileBytes;
  const ok = ed25519Verify(pub.pk, msg, sig.sig);
  if (!ok) return { ok: false, reason: 'Ed25519 验签失败 (文件被改过或签名损坏)' };
  return { ok: true, reason: '签名有效' };
}

async function fetchBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`下载失败 ${r.status}: ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.manifest || !args.pubkey) {
    console.error('用法: --manifest <latest.json|url> --pubkey <base64> [--file <本地包>]');
    process.exit(2);
  }
  const pub = parsePublicKey(args.pubkey);
  const manifestText = /^https?:/.test(args.manifest)
    ? await (await fetch(args.manifest)).text()
    : fs.readFileSync(args.manifest, 'utf8');
  const manifest = JSON.parse(manifestText);
  const platforms = manifest.platforms || {};
  const keys = Object.keys(platforms);
  if (!keys.length) {
    console.error('❌ 清单里没有任何 platform 条目');
    process.exit(1);
  }
  console.log(`清单版本: ${manifest.version} · 平台数: ${keys.length} · 公钥 id: ${pub.idHex}`);
  let failed = 0;
  for (const k of keys) {
    const entry = platforms[k];
    try {
      if (!entry.url) throw new Error('缺 url');
      if (!entry.signature) throw new Error('缺 signature (这就是 0.7.3–0.7.5 的症状)');
      const sig = parseSignature(entry.signature);
      const bytes = args.file && keys.length === 1 ? fs.readFileSync(args.file) : await fetchBytes(entry.url);
      const res = verifyBuffer(pub, sig, bytes);
      if (res.ok) {
        console.log(`  ✅ ${k}  ${path.basename(new URL(entry.url, 'http://x').pathname)}  ${(bytes.length / 1048576).toFixed(1)}MB  ${res.reason}`);
      } else {
        failed++;
        console.log(`  ❌ ${k}  ${res.reason}`);
      }
    } catch (e) {
      failed++;
      console.log(`  ❌ ${k}  ${e.message}`);
    }
  }
  if (failed) {
    console.error(`\n结论: ${failed} 个平台验签不通过 — 这样的清单发出去, 客户端会静默不更新`);
    process.exit(1);
  }
  console.log('\n结论: 全部平台验签通过 (客户端会接受这次更新)');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
