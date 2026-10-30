//! 订单标识 (约定 v1, 标签 `BOL1`) — x402 直付的"买的是哪件"
//!
//! 对齐 TS 版 `agents/x402/order-identity.ts` (字节级一致):
//!
//! ```text
//! nonce (32 字节) =
//!   [0..3]   标签 0x424f4c31 = "BOL1"
//!   [4..7]   orderSeq, uint32 大端 (同一买家重复买同件时递增)
//!   [8..31]  hash24 = keccak256( utf8(itemId) ‖ uint256be(orderSeq) )[0..23]
//! ```
//!
//! 去重语义: 链上 `(authorizer, nonce)` 只能用一次 ⇒ 同买家重复买同件必须换
//! orderSeq; 不同买家可用相同 nonce ⇒ 唯一键是 `(payer, nonce)`, nonce 单独不是。
//!
//! 零外部链依赖红线: keccak-256 为本地实现 (sha3-256 padding 不同不可替代),
//! 不依赖 ethers; 正确性靠与真链实测值对表的测试。

use tiny_keccak::{Hasher, Keccak};

/// 协议名 (冻结)
pub const ORDER_IDENTITY_PROTOCOL: &str = "bolloon-x402-order-identity/1";
/// 标签: ASCII "BOL1"
pub const ORDER_NONCE_TAG_ASCII: &str = "BOL1";
pub const ORDER_NONCE_TAG_HEX: &str = "424f4c31";
pub const ORDER_TAG_BYTES: usize = 4;
pub const ORDER_SEQ_BYTES: usize = 4;
pub const ORDER_HASH_BYTES: usize = 24;

/// EIP-3009 `AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)` topic0
pub const EIP3009_AUTHORIZATION_USED_TOPIC0: &str =
    "98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";

/// EIP-712 域类型串 (USDC / FiatToken 家族标准串)
pub const EIP712_DOMAIN_TYPEHASH_STR: &str =
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
/// EIP-3009 授权结构类型串
pub const EIP3009_TYPEHASH_STR: &str =
    "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)";

/// `DOMAIN_SEPARATOR()` selector
pub const SELECTOR_DOMAIN_SEPARATOR: &str = "3644e515";
/// `name()` selector
pub const SELECTOR_NAME: &str = "06fdde03";
/// `version()` selector
pub const SELECTOR_VERSION: &str = "54fd4d50";

/// keccak-256 (本地纯实现, 与 TS 版同算法)
pub fn keccak256(input: &[u8]) -> [u8; 32] {
    let mut hasher = Keccak::v256();
    hasher.update(input);
    let mut out = [0u8; 32];
    hasher.finalize(&mut out);
    out
}

/// uint256 大端 32 字节
pub fn uint256be(v: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&v.to_be_bytes());
    out
}

/// orderItemHash24 = keccak256(utf8(itemId) ‖ uint256be(orderSeq)) 前 24 字节 (hex, 不带 0x)
pub fn order_item_hash24(item_id: &str, order_seq: u64) -> String {
    let mut buf = Vec::new();
    buf.extend_from_slice(item_id.as_bytes());
    buf.extend_from_slice(&uint256be(order_seq));
    let h = keccak256(&buf);
    hex::encode(&h[..ORDER_HASH_BYTES])
}

/// order nonce 错误
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum OrderNonceError {
    #[error("orderSeq 超出 uint32 范围: {0}")]
    SeqOutOfRange(u64),
}

/// 计算订单 nonce (0x + 64 hex)
pub fn compute_order_nonce(item_id: &str, order_seq: u64) -> Result<String, OrderNonceError> {
    if order_seq > u32::MAX as u64 {
        return Err(OrderNonceError::SeqOutOfRange(order_seq));
    }
    let mut nonce = Vec::with_capacity(32);
    nonce.extend_from_slice(&hex::decode(ORDER_NONCE_TAG_HEX).expect("BOL1 tag"));
    nonce.extend_from_slice(&(order_seq as u32).to_be_bytes()); // 约定: uint32 大端 4 字节
    let hash = hex::decode(order_item_hash24(item_id, order_seq)).expect("hash24");
    nonce.extend_from_slice(&hash);
    Ok(format!("0x{}", hex::encode(nonce)))
}

/// 解码形状
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OrderNonceShape {
    /// 合法 BOL1 订单标识
    Ok,
    /// 不是 0x + 64 hex
    NotHex,
    /// 32 字节但长度不对 (理论上不可能, 防御)
    WrongLength,
    /// 前 4 字节不是 BOL1
    NoTag,
}

/// 解码结果 (对齐 TS DecodedOrderNonce)
#[derive(Debug, Clone)]
pub struct DecodedOrderNonce {
    pub nonce: String,
    pub shape: OrderNonceShape,
    pub order_seq: Option<u32>,
    /// 24 字节 hash (hex, 无 0x)
    pub item_id_hash: Option<String>,
    pub detail: String,
}

/// 解码 nonce (宽容输入: trim + 小写化)
pub fn decode_order_nonce(nonce: &str) -> DecodedOrderNonce {
    let raw = nonce.trim().to_lowercase();
    let body = raw.strip_prefix("0x").unwrap_or(&raw);
    let shell_detail = |d: String| DecodedOrderNonce {
        nonce: raw.clone(),
        shape: OrderNonceShape::NotHex,
        order_seq: None,
        item_id_hash: None,
        detail: d,
    };
    let bytes = match hex::decode(body) {
        Ok(b) if body.len() == 64 && b.len() == 32 => b,
        _ => {
            return shell_detail(format!(
                "nonce 形状不对 (要 32 字节 hex): {}",
                raw.chars().take(42).collect::<String>()
            ))
        }
    };
    let tag_hex = hex::encode(&bytes[..ORDER_TAG_BYTES]);
    if tag_hex != ORDER_NONCE_TAG_HEX {
        return DecodedOrderNonce {
            nonce: raw,
            shape: OrderNonceShape::NoTag,
            order_seq: None,
            item_id_hash: None,
            detail: format!(
                "nonce 前 4 字节 {tag_hex} ≠ {ORDER_NONCE_TAG_HEX} (\"BOL1\") —— 这不是按约定 v1 编的订单标识"
            ),
        };
    }
    let order_seq = u32::from_be_bytes(bytes[ORDER_TAG_BYTES..ORDER_TAG_BYTES + ORDER_SEQ_BYTES]
        .try_into()
        .expect("4 bytes"));
    let item_id_hash = hex::encode(&bytes[ORDER_TAG_BYTES + ORDER_SEQ_BYTES..]);
    let detail = format!(
        "BOL1 订单标识: orderSeq={order_seq}, itemIdHash={}…",
        &item_id_hash[..18.min(item_id_hash.len())]
    );
    DecodedOrderNonce {
        nonce: raw,
        shape: OrderNonceShape::Ok,
        order_seq: Some(order_seq),
        item_id_hash: Some(item_id_hash),
        detail,
    }
}

/// 卖方复算: nonce 是否自证"买的是本店 itemId"
///
/// 命中 = shape Ok 且 orderSeq 一致且 hash24 == 复算值。
pub fn match_order_nonce(nonce: &str, item_id: &str, expected_seq: u64) -> bool {
    let d = decode_order_nonce(nonce);
    match (d.shape, d.order_seq, d.item_id_hash) {
        (OrderNonceShape::Ok, Some(seq), Some(h)) => {
            seq as u64 == expected_seq && h == order_item_hash24(item_id, seq as u64)
        }
        _ => false,
    }
}

/// EIP-712 域分隔符 = keccak256(abi.encode(typeHash, keccak(name), keccak(version), chainId, contract))
///
/// `contract` 输入为 20 字节地址。**name 用 "USD Coin" 不是 "USDC"** (真链实测,
/// 用错的 name 签出来的授权链上必 revert)。
pub fn eip712_domain_separator(
    name: &str,
    version: &str,
    chain_id: u64,
    verifying_contract: &[u8; 20],
) -> String {
    let mut buf = Vec::with_capacity(160);
    buf.extend_from_slice(&keccak256(EIP712_DOMAIN_TYPEHASH_STR.as_bytes()));
    buf.extend_from_slice(&keccak256(name.as_bytes()));
    buf.extend_from_slice(&keccak256(version.as_bytes()));
    buf.extend_from_slice(&uint256be(chain_id));
    let mut addr32 = [0u8; 32];
    addr32[12..].copy_from_slice(verifying_contract);
    buf.extend_from_slice(&addr32);
    hex::encode(keccak256(&buf))
}

/// EIP-3009 授权摘要 = keccak256(abi.encode(TYPEHASH, from, to, value, validAfter, validBefore, nonce))
pub fn eip3009_authorization_digest(
    from: &[u8; 20],
    to: &[u8; 20],
    value: u128,
    valid_after: u64,
    valid_before: u64,
    nonce: &[u8; 32],
) -> [u8; 32] {
    let mut buf = Vec::with_capacity(32 * 7);
    buf.extend_from_slice(&keccak256(EIP3009_TYPEHASH_STR.as_bytes()));
    for addr in [from, to] {
        let mut a = [0u8; 32];
        a[12..].copy_from_slice(addr);
        buf.extend_from_slice(&a);
    }
    buf.extend_from_slice(&uint256be(value as u64));
    buf.extend_from_slice(&uint256be(valid_after));
    buf.extend_from_slice(&uint256be(valid_before));
    buf.extend_from_slice(nonce);
    keccak256(&buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真链实测锚 (2026-09-29, 两条 RPC 一致): USDC (Base) 合约地址
    const USDC_BASE_CONTRACT: [u8; 20] = [
        0x83, 0x35, 0x89, 0xfc, 0xd6, 0xed, 0xb6, 0xe0, 0x8f, 0x4c, 0x7c, 0x32, 0xd4, 0xf7, 0x1b,
        0x54, 0xbd, 0xa0, 0x29, 0x13,
    ];
    /// 真链 `DOMAIN_SEPARATOR()` 实测值
    const USDC_BASE_DOMAIN_SEPARATOR: &str =
        "02fa7265e7c5d81118673727957699e4d68f74cd74b7db77da710fe8a2c7834f";

    /// 与 TS 测试同锚: keccak256("") 与 keccak256("abc")
    #[test]
    fn keccak256_known_vectors() {
        assert_eq!(
            hex::encode(keccak256(b"")),
            "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
        );
        assert_eq!(
            hex::encode(keccak256(b"abc")),
            "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"
        );
    }

    #[test]
    fn nonce_shape_and_roundtrip() {
        let n = compute_order_nonce("info_efficode_spec_pack", 0).unwrap();
        assert_eq!(n.len(), 66, "0x + 64 hex");
        assert!(n.starts_with("0x424f4c31"), "前 4 字节必须是 BOL1");
        let d = decode_order_nonce(&n);
        assert_eq!(d.shape, OrderNonceShape::Ok);
        assert_eq!(d.order_seq, Some(0));
        assert_eq!(
            d.item_id_hash.as_deref(),
            Some(order_item_hash24("info_efficode_spec_pack", 0).as_str())
        );
    }

    #[test]
    fn nonce_tag_not_bol1_rejected() {
        let d = decode_order_nonce(&format!("0x{}64", "ab".repeat(31)));
        assert_eq!(d.shape, OrderNonceShape::NoTag);
    }

    #[test]
    fn nonce_bad_shape_rejected() {
        assert_eq!(decode_order_nonce("hello").shape, OrderNonceShape::NotHex);
        assert_eq!(decode_order_nonce("0x1234").shape, OrderNonceShape::NotHex);
    }

    #[test]
    fn seq_out_of_range_rejected() {
        assert_eq!(
            compute_order_nonce("x", u32::MAX as u64 + 1).unwrap_err(),
            OrderNonceError::SeqOutOfRange(u32::MAX as u64 + 1)
        );
    }

    #[test]
    fn match_nonce_self_attested_and_negative() {
        let n = compute_order_nonce("item_a", 7).unwrap();
        assert!(match_order_nonce(&n, "item_a", 7), "本店 item 复算命中 = 自证");
        assert!(!match_order_nonce(&n, "item_b", 7), "换 item 不命中");
        assert!(!match_order_nonce(&n, "item_a", 8), "换 seq 不命中");
        assert!(!match_order_nonce("0xdeadbeef", "item_a", 7), "非 BOL1 不命中");
    }

    #[test]
    fn same_item_different_seq_gives_different_nonce() {
        let a = compute_order_nonce("item", 0).unwrap();
        let b = compute_order_nonce("item", 1).unwrap();
        assert_ne!(a, b, "同件换 seq 必须换 nonce (链上 (authorizer,nonce) 唯一)");
    }

    /// ★ 真链对表锚: USDC (Base) DOMAIN_SEPARATOR
    /// name="USD Coin" (不是 "USDC"!), version="2", chainId=8453
    #[test]
    fn eip712_domain_matches_real_chain() {
        let ds = eip712_domain_separator("USD Coin", "2", 8453, &USDC_BASE_CONTRACT);
        assert_eq!(
            ds, USDC_BASE_DOMAIN_SEPARATOR,
            "必须与真链 DOMAIN_SEPARATOR() 实测值逐字一致"
        );
    }

    /// 用错的 name ("USDC") 算出来的域与真链不一致 —— 证伪断言钉住
    #[test]
    fn eip712_wrong_name_diverges() {
        let ds = eip712_domain_separator("USDC", "2", 8453, &USDC_BASE_CONTRACT);
        assert_ne!(ds, USDC_BASE_DOMAIN_SEPARATOR, "用符号当 name 必然对不上真链");
    }

    #[test]
    fn uint256be_layout() {
        let v = uint256be(1);
        assert!(v[..31].iter().all(|&b| b == 0), "高位 31 字节必须全 0");
        assert_eq!(v[31], 1);
    }
}
