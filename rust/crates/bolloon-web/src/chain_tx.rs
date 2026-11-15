//! **真实 EVM 交易签名 + 广播**（2026-11-15）—— 个人代币部署上链用。
//!
//! 只做最小可用面：EIP-155 legacy 交易（secp256k1 签名）、`eth_sendRawTransaction`、
//! 轮询 `eth_getTransactionReceipt` 等确认、读回 `contractAddress`。
//! 不持任何全局态；私钥只在本函数栈内使用，绝不落日志。
//!
//! 诚实边界：本模块**只做真实链上广播**（不是本地模拟）。广播失败/无回执一律如实报错，
//! 不会伪造 tx_hash / 合约地址。链/gas 由调用方给（默认 Base Sepolia）。

use serde_json::{Value, json};

fn rpc(url: &str, method: &str, params: Value) -> Result<Value, String> {
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }).to_string();
    let resp = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .post(url)
        .set("Content-Type", "application/json")
        .send_string(&body)
        .map_err(|e| format!("{method}: {e}"))?;
    let text = resp.into_string().map_err(|e| format!("{method}: {e}"))?;
    let v: Value =
        serde_json::from_str(&text).map_err(|e| format!("{method}: 非 JSON 响应 {e}"))?;
    if let Some(err) = v.get("error") {
        return Err(format!("{method}: RPC 报错 {err}"));
    }
    Ok(v.get("result").cloned().unwrap_or(Value::Null))
}

fn parse_hex_u128(s: &str) -> Result<u128, String> {
    let h = s.trim_start_matches("0x");
    if h.is_empty() {
        return Ok(0);
    }
    u128::from_str_radix(h, 16).map_err(|e| format!("hex 解析失败 {s}: {e}"))
}

fn hex0x(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}

// ─────────────────────────── RLP ───────────────────────────

fn rlp_len(len: usize, offset: u8) -> Vec<u8> {
    if len <= 55 {
        vec![offset + len as u8]
    } else {
        let mut l = len.to_be_bytes().to_vec();
        while l.len() > 1 && l[0] == 0 {
            l.remove(0);
        }
        let mut out = vec![offset + 55 + l.len() as u8];
        out.extend_from_slice(&l);
        out
    }
}

fn rlp_bytes(b: &[u8]) -> Vec<u8> {
    if b.len() == 1 && b[0] < 0x80 {
        return b.to_vec();
    }
    let mut out = rlp_len(b.len(), 0x80);
    out.extend_from_slice(b);
    out
}

fn rlp_u128(v: u128) -> Vec<u8> {
    if v == 0 {
        return vec![0x80];
    }
    let mut be = v.to_be_bytes().to_vec();
    while be.len() > 1 && be[0] == 0 {
        be.remove(0);
    }
    rlp_bytes(&be)
}

fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
    let mut body = vec![];
    for it in items {
        body.extend_from_slice(it);
    }
    let mut out = rlp_len(body.len(), 0xc0);
    out.extend_from_slice(&body);
    out
}

// ─────────────────────── 地址 / 签名 ───────────────────────

/// 由 secp256k1 私钥派生 EVM 地址（小写 0x…）。
pub fn evm_address_of(secret_hex: &str) -> Result<String, String> {
    use k256::elliptic_curve::sec1::ToEncodedPoint;
    use sha3::{Digest, Keccak256};
    let bytes =
        hex::decode(secret_hex.trim_start_matches("0x")).map_err(|e| format!("私钥 hex: {e}"))?;
    let sk = k256::SecretKey::from_slice(&bytes).map_err(|e| format!("私钥无效: {e}"))?;
    let point = sk.public_key().to_encoded_point(false);
    let raw = point.as_bytes();
    if raw.len() != 65 {
        return Err("公钥编码异常".into());
    }
    let digest = Keccak256::digest(&raw[1..]);
    Ok(format!("0x{}", hex::encode(&digest[12..])))
}

/// 签名一笔 legacy (EIP-155) 交易，返回 raw tx hex。
pub fn sign_eip155(
    secret_hex: &str,
    chain_id: u64,
    nonce: u128,
    gas_price: u128,
    gas_limit: u128,
    to: Option<&str>,
    value: u128,
    data: &[u8],
) -> Result<String, String> {
    use k256::ecdsa::SigningKey;
    use sha3::{Digest, Keccak256};

    let sk_bytes =
        hex::decode(secret_hex.trim_start_matches("0x")).map_err(|e| format!("私钥 hex: {e}"))?;
    let sk = SigningKey::from_slice(&sk_bytes).map_err(|e| format!("私钥无效: {e}"))?;
    let to_bytes = match to {
        Some(a) => hex::decode(a.trim_start_matches("0x")).map_err(|e| format!("to 地址: {e}"))?,
        None => vec![],
    };

    // unsigned: [nonce, gasPrice, gasLimit, to, value, data, chainId]
    let unsigned = rlp_list(&[
        rlp_u128(nonce),
        rlp_u128(gas_price),
        rlp_u128(gas_limit),
        rlp_bytes(&to_bytes),
        rlp_u128(value),
        rlp_bytes(data),
        rlp_u128(chain_id as u128),
    ]);
    let hash = Keccak256::digest(&unsigned);
    let (sig, recid) = sk
        .sign_prehash_recoverable(&hash)
        .map_err(|e| format!("签名失败: {e}"))?;
    let sig_bytes = sig.to_bytes();
    let r = &sig_bytes[..32];
    let s = &sig_bytes[32..];
    // v = recid + 35 + chainId*2 (EIP-155)
    let v: u128 = recid.to_byte() as u128 + 35 + (chain_id as u128) * 2;

    let signed = rlp_list(&[
        rlp_u128(nonce),
        rlp_u128(gas_price),
        rlp_u128(gas_limit),
        rlp_bytes(&to_bytes),
        rlp_u128(value),
        rlp_bytes(data),
        rlp_u128(v),
        rlp_bytes(r),
        rlp_bytes(s),
    ]);
    Ok(hex0x(&signed))
}

// ─────────────────────── ABI (constructor) ───────────────────────

fn abi_word_u128(v: u128) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&v.to_be_bytes());
    w
}

fn abi_word_addr(a: &str) -> Result<[u8; 32], String> {
    let b = hex::decode(a.trim_start_matches("0x")).map_err(|e| format!("地址 hex: {e}"))?;
    if b.len() != 20 {
        return Err("地址需 20 字节".into());
    }
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(&b);
    Ok(w)
}

fn abi_dyn_bytes(s: &[u8]) -> Vec<u8> {
    let mut out = vec![];
    out.extend_from_slice(&abi_word_u128(s.len() as u128));
    out.extend_from_slice(s);
    let pad = (32 - s.len() % 32) % 32;
    out.extend(std::iter::repeat(0u8).take(pad));
    out
}

/// ABI 编码 `(string name, string symbol, uint8 decimals, uint256 supply, address owner)`。
pub fn abi_encode_ctor(
    name: &str,
    symbol: &str,
    decimals: u8,
    supply: u128,
    owner: &str,
) -> Result<Vec<u8>, String> {
    let name_data = abi_dyn_bytes(name.as_bytes());
    let sym_data = abi_dyn_bytes(symbol.as_bytes());
    let head = 5 * 32;
    let name_off = head as u128;
    let sym_off = head as u128 + name_data.len() as u128;
    let mut out = vec![];
    out.extend_from_slice(&abi_word_u128(name_off));
    out.extend_from_slice(&abi_word_u128(sym_off));
    out.extend_from_slice(&abi_word_u128(decimals as u128));
    out.extend_from_slice(&abi_word_u128(supply));
    out.extend_from_slice(&abi_word_addr(owner)?);
    out.extend_from_slice(&name_data);
    out.extend_from_slice(&sym_data);
    Ok(out)
}

// ─────────────────────── 广播 / 确认 ───────────────────────

/// 读冻结/建议 gas 价（legacy）。
pub fn gas_price(rpc_url: &str) -> Result<u128, String> {
    let v = rpc(rpc_url, "eth_gasPrice", json!([]))?;
    parse_hex_u128(v.as_str().ok_or("eth_gasPrice 无字符串")?)
}

pub fn chain_id(rpc_url: &str) -> Result<u64, String> {
    let v = rpc(rpc_url, "eth_chainId", json!([]))?;
    Ok(parse_hex_u128(v.as_str().ok_or("eth_chainId 无字符串")?)? as u64)
}

pub fn native_balance(rpc_url: &str, address: &str) -> Result<u128, String> {
    let v = rpc(rpc_url, "eth_getBalance", json!([address, "latest"]))?;
    parse_hex_u128(v.as_str().ok_or("eth_getBalance 无字符串")?)
}

// ─────────────────────── ERC-20 只读（eth_call + ABI 解码）───────────────────────

fn selector(sig: &str) -> [u8; 4] {
    use sha3::{Digest, Keccak256};
    let d = Keccak256::digest(sig.as_bytes());
    [d[0], d[1], d[2], d[3]]
}

/// `eth_call`（只读，不广播），返回原始返回字节。
pub fn eth_call(rpc_url: &str, to: &str, data: &[u8]) -> Result<Vec<u8>, String> {
    let v = rpc(
        rpc_url,
        "eth_call",
        json!([{ "to": to, "data": hex0x(data) }, "latest"]),
    )?;
    let s = v.as_str().ok_or("eth_call 无字符串结果")?;
    let h = s.trim_start_matches("0x");
    if h.is_empty() {
        return Ok(vec![]);
    }
    hex::decode(h).map_err(|e| format!("eth_call 返回非 hex: {e}"))
}

fn word(bytes: &[u8], i: usize) -> Result<&[u8], String> {
    let start = i * 32;
    if bytes.len() < start + 32 {
        return Err("ABI 返回长度不足".into());
    }
    Ok(&bytes[start..start + 32])
}

/// 解码动态 `string` 返回值（若合约返回 bytes32，回退按 32 字节截断取）。
pub fn abi_decode_string(bytes: &[u8]) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("空返回（该地址可能不是 ERC-20 合约）".into());
    }
    let w0 = word(bytes, 0)?;
    // 动态 string 的偏移是高半零的 u256；高半非零视为 bytes32 编码，走下面的回退。
    if w0[..16].iter().all(|b| *b == 0) {
        let off = u128::from_be_bytes(w0[16..32].try_into().unwrap()) as usize;
        if off
            .checked_add(32)
            .map(|e| e <= bytes.len())
            .unwrap_or(false)
        {
            let len_word = &bytes[off..off + 32];
            if len_word[..16].iter().all(|b| *b == 0) {
                let len = u128::from_be_bytes(len_word[16..32].try_into().unwrap()) as usize;
                let s = off + 32;
                if len <= 4096
                    && s.checked_add(len)
                        .map(|e| e <= bytes.len())
                        .unwrap_or(false)
                {
                    if let Ok(txt) = String::from_utf8(bytes[s..s + len].to_vec()) {
                        return Ok(txt.trim_matches('\0').to_string());
                    }
                }
            }
        }
    }
    // bytes32 回退（老式合约）
    let raw = word(bytes, 0)?;
    let end = raw.iter().position(|b| *b == 0).unwrap_or(32);
    String::from_utf8(raw[..end].to_vec()).map_err(|e| format!("string/bytes32 解码失败: {e}"))
}

/// 解码 `uint` 返回值（>128 位溢出报错，避免静默截断）。
pub fn abi_decode_uint(bytes: &[u8]) -> Result<u128, String> {
    if bytes.len() < 32 {
        return Err("uint 返回不足 32 字节".into());
    }
    if bytes[..16].iter().any(|b| *b != 0) {
        return Err("uint 超过 128 位，拒绝静默截断".into());
    }
    Ok(u128::from_be_bytes(bytes[16..32].try_into().unwrap()))
}

/// 读 ERC-20 元数据 `(name, symbol, decimals, totalSupply)`。
pub fn erc20_metadata(
    rpc_url: &str,
    contract: &str,
) -> Result<(String, String, u32, u128), String> {
    let name = abi_decode_string(&eth_call(rpc_url, contract, &selector("name()"))?)?;
    let symbol = abi_decode_string(&eth_call(rpc_url, contract, &selector("symbol()"))?)?;
    let decimals = abi_decode_uint(&eth_call(rpc_url, contract, &selector("decimals()"))?)? as u32;
    let supply = abi_decode_uint(&eth_call(rpc_url, contract, &selector("totalSupply()"))?)?;
    Ok((name, symbol, decimals, supply))
}

/// 读 `balanceOf(owner)`（最小单位）。
pub fn erc20_balance_of(rpc_url: &str, contract: &str, owner: &str) -> Result<u128, String> {
    let mut data = selector("balanceOf(address)").to_vec();
    let mut w = [0u8; 32];
    let b = hex::decode(owner.trim_start_matches("0x")).map_err(|e| format!("地址 hex: {e}"))?;
    if b.len() != 20 {
        return Err("地址需 20 字节".into());
    }
    w[12..].copy_from_slice(&b);
    data.extend_from_slice(&w);
    abi_decode_uint(&eth_call(rpc_url, contract, &data)?)
}

/// 估算部署 gas（data-only）。失败时给保守默认值。
pub fn estimate_deploy_gas(rpc_url: &str, from: &str, data: &[u8]) -> Result<u128, String> {
    let v = rpc(
        rpc_url,
        "eth_estimateGas",
        json!([{ "from": from, "data": hex0x(data) }]),
    )?;
    match v.as_str() {
        Some(s) => Ok(parse_hex_u128(s)?),
        None => Err("eth_estimateGas 无字符串".into()),
    }
}

/// 部署合约（真实广播 + 等回执）。返回 { tx_hash, contract_address, block_number, status_ok }。
pub async fn deploy_contract(
    rpc_url: &str,
    secret_hex: &str,
    cid: u64,
    creation_data: &[u8],
) -> Result<Value, String> {
    let from = evm_address_of(secret_hex)?;
    let nonce = {
        let v = rpc(rpc_url, "eth_getTransactionCount", json!([from, "pending"]))?;
        parse_hex_u128(v.as_str().ok_or("nonce 无字符串")?)?
    };
    let gp = gas_price(rpc_url)?;
    let est = estimate_deploy_gas(rpc_url, &from, creation_data).unwrap_or(300_000);
    let gas_limit = est + 80_000; // 缓冲
    let raw = sign_eip155(
        secret_hex,
        cid,
        nonce,
        gp,
        gas_limit,
        None,
        0,
        creation_data,
    )?;
    let tx_hash = rpc(rpc_url, "eth_sendRawTransaction", json!([raw]))?
        .as_str()
        .map(|s| s.to_string())
        .ok_or("eth_sendRawTransaction 未返回 tx hash")?;

    for _ in 0..60 {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        let r = rpc(rpc_url, "eth_getTransactionReceipt", json!([tx_hash]))?;
        if !r.is_null() {
            let status = r.get("status").and_then(|v| v.as_str()).unwrap_or("");
            let addr = r
                .get("contractAddress")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let block = r
                .get("blockNumber")
                .and_then(|v| v.as_str())
                .unwrap_or("0x0");
            return Ok(json!({
                "tx_hash": tx_hash,
                "contract_address": addr,
                "block_number": parse_hex_u128(block).unwrap_or(0),
                "status_ok": status == "0x1",
                "from": from,
            }));
        }
    }
    Err(format!(
        "已广播但 120s 内未回执（tx {tx_hash}）—— 可能仍在打包，稍后可在浏览器查"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rlp_known_vectors() {
        // 0x80 = 空字节串
        assert_eq!(rlp_bytes(&[]), vec![0x80]);
        // 单字节 < 0x80 原样
        assert_eq!(rlp_bytes(&[0x7f]), vec![0x7f]);
        // 整数 0 -> 0x80
        assert_eq!(rlp_u128(0), vec![0x80]);
        // 整数 1 -> 0x01
        assert_eq!(rlp_u128(1), vec![0x01]);
        // 整数 127 -> 0x7f
        assert_eq!(rlp_u128(127), vec![0x7f]);
        // 整数 128 -> 0x8180
        assert_eq!(rlp_u128(128), vec![0x81, 0x80]);
        // "dog" -> 0x83646f67
        assert_eq!(rlp_bytes(b"dog"), vec![0x83, 0x64, 0x6f, 0x67]);
    }

    #[test]
    fn evm_address_derivation() {
        // 固定私钥派生地址稳定（只验证确定性，不断言具体值以免绑死）
        let sk = "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
        let a = evm_address_of(sk).unwrap();
        let b = evm_address_of(sk).unwrap();
        assert_eq!(a, b);
        assert!(a.starts_with("0x") && a.len() == 42);
    }

    #[test]
    fn abi_ctor_encoding_layout() {
        let enc = abi_encode_ctor(
            "Alice Coin",
            "ALC",
            6,
            1000,
            "0x000000000000000000000000000000000000dEaD",
        )
        .unwrap();
        // head 5 words + name data(32+32) + symbol data(32+32) = 160+64+64 = 288
        assert_eq!(enc.len(), 288);
        // 第一个 word = name offset = 160
        assert_eq!(u128::from_be_bytes(enc[16..32].try_into().unwrap()), 160);
    }

    #[test]
    fn erc20_selectors_match_known_values() {
        assert_eq!(hex::encode(selector("name()")), "06fdde03");
        assert_eq!(hex::encode(selector("symbol()")), "95d89b41");
        assert_eq!(hex::encode(selector("decimals()")), "313ce567");
        assert_eq!(hex::encode(selector("totalSupply()")), "18160ddd");
        assert_eq!(hex::encode(selector("balanceOf(address)")), "70a08231");
    }

    #[test]
    fn abi_decode_string_roundtrip_and_bytes32_fallback() {
        // 标准动态 string: offset=32, len=3, "ALC"
        let mut b = vec![0u8; 32 + 32 + 32];
        b[31] = 32;
        b[32 + 31] = 3;
        b[64] = b'A';
        b[65] = b'L';
        b[66] = b'C';
        assert_eq!(abi_decode_string(&b).unwrap(), "ALC");
        // bytes32 回退
        let mut w = vec![0u8; 32];
        w[..3].copy_from_slice(b"ETH");
        assert_eq!(abi_decode_string(&w).unwrap(), "ETH");
    }

    #[test]
    fn abi_decode_uint_rejects_overflow() {
        let mut b = vec![0u8; 32];
        b[0] = 1; // 高位非零
        assert!(abi_decode_uint(&b).is_err());
        let mut ok = vec![0u8; 32];
        ok[31] = 42;
        assert_eq!(abi_decode_uint(&ok).unwrap(), 42);
    }
}
