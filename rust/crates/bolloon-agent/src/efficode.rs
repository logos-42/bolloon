//! Efficode — AI 专用交流语言 (参考实现)
//!
//! 对齐 TS 版 `src/efficode/` (帧结构逐字节一致):
//!
//! ```text
//! [Header 2B] | [DID 段 32B, 可省] | [指令段 动态] | [数据块 动态] | [CRC32 4B]
//!   byte0: version(高4) | mode(低4)        mode: 0=compact 1=text
//!   byte1: flags  bit0=有DID bit1=有指令 bit2=有数据 bit3=数据已压缩  bit4..7 保留(必须0)
//! ```
//!
//! 两条硬纪律:
//! ① 解析逐段自描述 — 长度对不上就报截断, 不许"能解多少解多少";
//! ② CRC32 覆盖 CRC 之前全部字节, 对不上报 CrcMismatch, 绝不放行。
//!
//! 诚实边界: CRC32 只防传输损坏不是防篡改 (无密钥); 防篡改走真签名 (did 段+信封)。

/// 版本
pub const EFFICODE_VERSION: u8 = 1;
/// DID 段固定 32 字节
pub const DID_SEGMENT_BYTES: usize = 32;
/// CRC 尾段 4 字节
pub const CRC_BYTES: usize = 4;
/// 最小包 (header + crc)
pub const MIN_PACKET_BYTES: usize = 2 + CRC_BYTES;

const F_HAS_DID: u8 = 1 << 0;
const F_HAS_OP: u8 = 1 << 1;
const F_HAS_DATA: u8 = 1 << 2;
const F_COMPRESSED: u8 = 1 << 3;
const FLAG_RESERVED: u8 = 0xf0;

/// 模式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum EfficodeMode {
    #[default]
    Compact,
    Text,
}

/// Efficode 错误 (码对齐 TS)
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum EfficodeError {
    #[error("EFFICODE_TRUNCATED: {0} (at {1})")]
    Truncated(String, usize),
    #[error("EFFICODE_BAD_HEADER: {0}")]
    BadHeader(String),
    #[error("EFFICODE_CRC_MISMATCH: 期望 {expected:08x} 实得 {actual:08x}")]
    CrcMismatch { expected: u32, actual: u32 },
    #[error("EFFICODE_UNKNOWN_OP: {0}")]
    UnknownOp(u8),
    #[error("EFFICODE_BAD_INSTRUCTION: {0}")]
    BadInstruction(String),
}

/// 六条符号指令 (code 对齐 TS OP_TABLE)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    /// @DID: 指明对话对象
    AtDid,
    /// #DATA: 数据块声明
    Data,
    /// #REQ: 请求
    Req,
    /// !ACK: 确认
    Ack,
    /// !SEND: 发送
    Send,
    /// !END: 结束
    End,
}

impl Op {
    fn code(self) -> u8 {
        match self {
            Op::AtDid => 1,
            Op::Data => 2,
            Op::Req => 3,
            Op::Ack => 4,
            Op::Send => 5,
            Op::End => 6,
        }
    }
    fn prefix(self) -> &'static str {
        match self {
            Op::AtDid => "@DID:",
            Op::Data => "#DATA:",
            Op::Req => "#REQ:",
            Op::Ack => "!ACK",
            Op::Send => "!SEND",
            Op::End => "!END",
        }
    }
    fn from_code(c: u8) -> Option<Self> {
        Some(match c {
            1 => Op::AtDid,
            2 => Op::Data,
            3 => Op::Req,
            4 => Op::Ack,
            5 => Op::Send,
            6 => Op::End,
            _ => return None,
        })
    }
    fn from_prefix_token(tok: &str) -> Option<Self> {
        // 前缀表达式四条写死的解析规则: sigil 开头, 逐条对表
        Some(match tok {
            t if t.starts_with("@DID") => Op::AtDid,
            t if t.starts_with("#DATA") => Op::Data,
            t if t.starts_with("#REQ") => Op::Req,
            t if t.starts_with("!ACK") => Op::Ack,
            t if t.starts_with("!SEND") => Op::Send,
            t if t.starts_with("!END") => Op::End,
            _ => return None,
        })
    }
}

/// 一条指令 (op + 可选参数)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Instruction {
    pub op: Op,
    /// 参数 (@DID: 目标 did 摘要; #DATA/#REQ: 关联 id …)
    pub arg: Option<String>,
}

/// 待编码消息
#[derive(Debug, Clone, Default)]
pub struct EfficodeMessage {
    /// DID 段 (32B 摘要; None = 省略省 32B)
    pub did: Option<[u8; 32]>,
    pub instructions: Vec<Instruction>,
    /// 数据块 (None = 省略)
    pub data: Option<Vec<u8>>,
    pub mode: EfficodeMode,
}

/// 解码出的包
#[derive(Debug, Clone)]
pub struct DecodedPacket {
    pub version: u8,
    pub mode: EfficodeMode,
    pub did: Option<[u8; 32]>,
    pub instructions: Vec<Instruction>,
    /// 解压后的数据块
    pub data: Option<Vec<u8>>,
}

// ────────────────────────────── CRC32 (IEEE, 与 TS crc32.ts 一致) ──────────────────────────

fn crc32_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { 0xedb88320 ^ (c >> 1) } else { c >> 1 };
            k += 1;
        }
        table[i] = c;
        i += 1;
    }
    table
}

/// CRC32 (IEEE 802.3)
pub fn crc32(data: &[u8]) -> u32 {
    let table = crc32_table();
    let mut crc = 0xffffffffu32;
    for &b in data {
        crc = table[((crc ^ b as u32) & 0xff) as usize] ^ (crc >> 8);
    }
    crc ^ 0xffffffff
}

// ────────────────────────────── varint ──────────────────────────

fn write_varint(out: &mut Vec<u8>, mut v: u32) {
    loop {
        if v >= 0x80 {
            out.push((v & 0x7f) as u8 | 0x80);
            v >>= 7;
        } else {
            out.push(v as u8);
            break;
        }
    }
}

fn read_varint(buf: &[u8], pos: &mut usize) -> Result<u32, EfficodeError> {
    let mut value: u32 = 0;
    let mut shift = 0;
    loop {
        if *pos >= buf.len() {
            return Err(EfficodeError::Truncated("varint 未读完就到底".into(), *pos));
        }
        let b = buf[*pos];
        *pos += 1;
        value |= ((b & 0x7f) as u32) << shift;
        if b & 0x80 == 0 {
            break;
        }
        shift += 7;
        if shift > 28 {
            return Err(EfficodeError::Truncated("varint 超过 32 位上限".into(), *pos));
        }
    }
    Ok(value)
}

// ────────────────────────────── 编码 ──────────────────────────

/// 编码消息为包 (帧 + CRC)
pub fn encode(msg: &EfficodeMessage) -> Result<Vec<u8>, EfficodeError> {
    if msg.instructions.len() > 4096 {
        return Err(EfficodeError::BadInstruction("指令数超限".into()));
    }
    let mut body: Vec<u8> = Vec::new();

    // DID 段
    let has_did = msg.did.is_some();
    if let Some(did) = &msg.did {
        body.extend_from_slice(did);
    }

    // 指令段
    let has_op = !msg.instructions.is_empty();
    if has_op {
        let mut op_seg = Vec::new();
        for ins in &msg.instructions {
            op_seg.push(ins.op.code());
            if let Some(arg) = &ins.arg {
                write_varint(&mut op_seg, arg.len() as u32);
                op_seg.extend_from_slice(arg.as_bytes());
            } else {
                write_varint(&mut op_seg, 0);
            }
        }
        write_varint(&mut body, op_seg.len() as u32);
        body.extend_from_slice(&op_seg);
    }

    // 数据块
    let has_data = msg.data.is_some();
    if let Some(data) = &msg.data {
        write_varint(&mut body, data.len() as u32);
        body.extend_from_slice(data);
    }

    // header
    let mut flags = 0u8;
    if has_did {
        flags |= F_HAS_DID;
    }
    if has_op {
        flags |= F_HAS_OP;
    }
    if has_data {
        flags |= F_HAS_DATA;
    }
    // F_COMPRESSED 仅由压缩路径置位 (本参考实现不做压缩, 如实标 0)
    let mode_num = match msg.mode {
        EfficodeMode::Compact => 0u8,
        EfficodeMode::Text => 1u8,
    };
    let mut packet = vec![(EFFICODE_VERSION << 4) | mode_num, flags];
    packet.extend_from_slice(&body);

    // CRC 覆盖之前全部字节
    let crc = crc32(&packet);
    packet.extend_from_slice(&crc.to_be_bytes());
    Ok(packet)
}

// ────────────────────────────── 解码 ──────────────────────────

/// 解码 (逐段自描述 + CRC 硬门)
///
/// 顺序对齐 TS: 先 header/逐段长度解析 (截断先报 Truncated), 段解析成功后验 CRC
pub fn decode(bytes: &[u8]) -> Result<DecodedPacket, EfficodeError> {
    if bytes.len() < MIN_PACKET_BYTES {
        return Err(EfficodeError::Truncated(
            format!("包长 {} < 最小 {MIN_PACKET_BYTES}", bytes.len()),
            0,
        ));
    }
    let (body_all, crc_bytes) = bytes.split_at(bytes.len() - CRC_BYTES);

    let b0 = body_all[0];
    let version = b0 >> 4;
    if version != EFFICODE_VERSION {
        return Err(EfficodeError::BadHeader(format!("version {version} ≠ {EFFICODE_VERSION}")));
    }
    let mode = match b0 & 0x0f {
        0 => EfficodeMode::Compact,
        1 => EfficodeMode::Text,
        other => return Err(EfficodeError::BadHeader(format!("未知 mode {other}"))),
    };
    let flags = body_all[1];
    if flags & FLAG_RESERVED != 0 {
        return Err(EfficodeError::BadHeader(format!(
            "保留位非 0 (flags={flags:#04x}) — 不放行"
        )));
    }

    // pos 相对 rest (body_all[2..]) — rest 已扣除 header, 不再带 2 的偏移
    let mut pos = 0usize;
    let rest = &body_all[2..];

    // DID 段
    let did = if flags & F_HAS_DID != 0 {
        if pos + DID_SEGMENT_BYTES > rest.len() {
            return Err(EfficodeError::Truncated("DID 段不完整".into(), pos));
        }
        let mut d = [0u8; 32];
        d.copy_from_slice(&rest[pos..pos + DID_SEGMENT_BYTES]);
        pos += DID_SEGMENT_BYTES;
        Some(d)
    } else {
        None
    };

    // 指令段
    let instructions = if flags & F_HAS_OP != 0 {
        let op_len = read_varint(rest, &mut pos)? as usize;
        if pos + op_len > rest.len() {
            return Err(EfficodeError::Truncated("指令段长度超出".into(), pos));
        }
        let op_seg = &rest[pos..pos + op_len];
        pos += op_len;
        parse_op_segment(op_seg)?
    } else {
        vec![]
    };

    // 数据块
    let data = if flags & F_HAS_DATA != 0 {
        let data_len = read_varint(rest, &mut pos)? as usize;
        if pos + data_len > rest.len() {
            return Err(EfficodeError::Truncated("数据块长度超出".into(), pos));
        }
        Some(rest[pos..pos + data_len].to_vec())
    } else {
        None
    };

    // CRC 硬门最后验: 段解析都成立, 再对内容完整性把关
    let expected = u32::from_be_bytes(crc_bytes.try_into().unwrap());
    let actual = crc32(body_all);
    if expected != actual {
        return Err(EfficodeError::CrcMismatch { expected, actual });
    }

    Ok(DecodedPacket {
        version,
        mode,
        did,
        instructions,
        data,
    })
}

fn parse_op_segment(seg: &[u8]) -> Result<Vec<Instruction>, EfficodeError> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while pos < seg.len() {
        let code = seg[pos];
        pos += 1;
        let op = Op::from_code(code).ok_or(EfficodeError::UnknownOp(code))?;
        let arg_len = read_varint(seg, &mut pos)? as usize;
        if pos + arg_len > seg.len() {
            return Err(EfficodeError::Truncated("指令参数超出段长".into(), pos));
        }
        let arg = if arg_len > 0 {
            Some(String::from_utf8_lossy(&seg[pos..pos + arg_len]).into_owned())
        } else {
            None
        };
        pos += arg_len;
        out.push(Instruction { op, arg });
    }
    Ok(out)
}

// ────────────────────────────── 符号文本 (text 模式) ──────────────────────────

/// 符号化: 指令 → "@DID:xxx #DATA:id !ACK" 形式
pub fn instructions_to_symbolic(instructions: &[Instruction]) -> String {
    instructions
        .iter()
        .map(|i| {
            let base = i.op.prefix().to_string();
            match (&i.arg, i.op) {
                (Some(a), Op::AtDid | Op::Data | Op::Req) => format!("{base}{a}"),
                _ => base.trim_end_matches(':').to_string(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// 解析符号文本 → 指令 (前缀表达式四条写死规则; 非法 token 报错不猜)
pub fn symbolic_to_instructions(text: &str) -> Result<Vec<Instruction>, EfficodeError> {
    let mut out: Vec<Instruction> = Vec::new();
    for tok in text.trim().split_whitespace() {
        if let Some(op) = Op::from_prefix_token(tok) {
            let arg = match op {
                Op::AtDid => tok.strip_prefix("@DID:").map(|s| s.to_string()),
                Op::Data => tok.strip_prefix("#DATA:").map(|s| s.to_string()),
                Op::Req => tok.strip_prefix("#REQ:").map(|s| s.to_string()),
                _ => None,
            };
            out.push(Instruction { op, arg });
        } else if !out.is_empty() {
            // 裸 token 附加到上一条指令参数 (写死规则: 非sigil token 归并)
            let last = out.last_mut().unwrap();
            last.arg = Some(match last.arg.take() {
                Some(a) => format!("{a} {tok}"),
                None => tok.to_string(),
            });
        } else {
            return Err(EfficodeError::BadInstruction(format!("首 token 非指令: {tok}")));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_msg() -> EfficodeMessage {
        EfficodeMessage {
            did: Some([7u8; 32]),
            instructions: vec![
                Instruction { op: Op::AtDid, arg: Some("z6MkTarget".into()) },
                Instruction { op: Op::Req, arg: Some("weather".into()) },
                Instruction { op: Op::End, arg: None },
            ],
            data: Some(b"payload-123".to_vec()),
            mode: EfficodeMode::Compact,
        }
    }

    #[test]
    fn encode_decode_roundtrip() {
        let msg = sample_msg();
        let bytes = encode(&msg).unwrap();
        let pkt = decode(&bytes).unwrap();
        assert_eq!(pkt.version, EFFICODE_VERSION);
        assert_eq!(pkt.mode, EfficodeMode::Compact);
        assert_eq!(pkt.did, Some([7u8; 32]));
        assert_eq!(pkt.instructions, msg.instructions);
        assert_eq!(pkt.data.as_deref(), Some(b"payload-123".as_slice()));
    }

    #[test]
    fn did_omitted_saves_32_bytes() {
        let mut full = sample_msg();
        full.did = Some([1; 32]);
        let mut bare = sample_msg();
        bare.did = None;
        let l_full = encode(&full).unwrap().len();
        let l_bare = encode(&bare).unwrap().len();
        assert_eq!(l_full - l_bare, DID_SEGMENT_BYTES, "省略 DID 段必须真省 32B");
    }

    #[test]
    fn crc_flipped_bit_rejected() {
        let mut bytes = encode(&sample_msg()).unwrap();
        let mid = bytes.len() / 2;
        bytes[mid] ^= 0x01; // 翻转正文中 1 bit
        let err = decode(&bytes).unwrap_err();
        assert!(matches!(err, EfficodeError::CrcMismatch { .. }), "CRC 硬门必须拦");
    }

    #[test]
    fn truncated_packet_rejected() {
        let bytes = encode(&sample_msg()).unwrap();
        let err = decode(&bytes[..bytes.len() - 3]).unwrap_err();
        assert!(matches!(err, EfficodeError::Truncated(..)));
    }

    #[test]
    fn reserved_flag_bits_rejected() {
        let mut bytes = encode(&sample_msg()).unwrap();
        bytes[1] |= 0xf0; // 置保留位
        // 修 CRC 绕过 CRC 门, reserved 门必须独立拦
        let crc = crc32(&bytes[..bytes.len() - 4]);
        bytes[..bytes.len() - 4].len();
        let body_len = bytes.len() - 4;
        bytes[body_len..].copy_from_slice(&crc.to_be_bytes());
        assert!(matches!(decode(&bytes).unwrap_err(), EfficodeError::BadHeader(_)));
    }

    #[test]
    fn unknown_opcode_rejected() {
        // 手工构造含未知 opcode 的指令段
        let mut op_seg = vec![9u8, 0]; // code 9 不存在
        let mut body = Vec::new();
        write_varint(&mut body, op_seg.len() as u32);
        body.append(&mut op_seg);
        let mut packet = vec![(EFFICODE_VERSION << 4), F_HAS_OP];
        packet.extend_from_slice(&body);
        let crc = crc32(&packet);
        packet.extend_from_slice(&crc.to_be_bytes());
        assert!(matches!(decode(&packet).unwrap_err(), EfficodeError::UnknownOp(9)));
    }

    #[test]
    fn symbolic_text_roundtrip() {
        let ins = vec![
            Instruction { op: Op::AtDid, arg: Some("z6MkX".into()) },
            Instruction { op: Op::Send, arg: None },
            Instruction { op: Op::End, arg: None },
        ];
        let text = instructions_to_symbolic(&ins);
        assert_eq!(text, "@DID:z6MkX !SEND !END");
        let back = symbolic_to_instructions(&text).unwrap();
        assert_eq!(back, ins);
    }

    #[test]
    fn symbolic_bare_token_attaches_to_previous() {
        let ins = symbolic_to_instructions("#DATA:abc def").unwrap();
        assert_eq!(ins[0].arg.as_deref(), Some("abc def"));
    }

    #[test]
    fn symbolic_leading_bare_token_rejected() {
        assert!(symbolic_to_instructions("hello world").is_err());
    }

    #[test]
    fn crc32_known_vector() {
        // 标准校验: crc32("123456789") = 0xCBF43926
        assert_eq!(crc32(b"123456789"), 0xcbf43926);
    }

    #[test]
    fn x40_frame_overhead_ratio_documented() {
        // wiki 实测: 20B 载荷 → 111B 包 (开销 4.55x) — 这里验真实帧形状的量级
        let msg = EfficodeMessage {
            did: Some([0; 32]),
            instructions: vec![
                Instruction { op: Op::AtDid, arg: Some("z6MkAB".into()) },
                Instruction { op: Op::Data, arg: Some("x".into()) },
            ],
            data: Some(vec![0u8; 20]),
            mode: EfficodeMode::Compact,
        };
        let bytes = encode(&msg).unwrap();
        // 帧头2 + did32 + opLen varint + 指令 + dataLen varint + 20 + crc4
        assert!(bytes.len() >= 32 + 20 + 8, "帧开销真实存在, 诚实记录不吹");
    }
}
