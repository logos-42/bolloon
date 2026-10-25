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
    #[error("EFFICODE_UNKNOWN_COMPRESSION: {0}")]
    UnknownCompression(String),
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
    /// 压缩算法 (None = 自动选: 压不小就退回 none, 省下的不该是负数)
    pub compression: Option<CompressionAlgo>,
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

// ────────────────────────────── 压缩层 (对齐 TS compress.ts / lz77.ts) ──────────────────────────────

/// 压缩算法 (数据块第一字节 = 算法 id)
///
/// 对齐 TS `COMPRESSION_IDS`: 0=none · 1=lz77 · 2=deflate。
/// 本参考实现只做 0/1: 收到 id=2 (deflate) **如实报未知算法**, 绝不"跳过解压直接给原文"。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CompressionAlgo {
    /// 原样 (小消息用 —— 头上开箱代价为 0)
    #[default]
    None,
    /// 本仓 LZ77 实现 (纯 Rust, 任何运行面可跑)
    Lz77,
}

impl CompressionAlgo {
    pub fn id(self) -> u8 {
        match self {
            Self::None => 0,
            Self::Lz77 => 1,
        }
    }
    pub fn from_id(id: u8) -> Option<Self> {
        match id {
            0 => Some(Self::None),
            1 => Some(Self::Lz77),
            _ => None,
        }
    }
}

const LZ_WINDOW: usize = 4095; // 12 位 offset (0 保留为非法)
const LZ_MIN_MATCH: usize = 3; // length-3 存 4 位 ⇒ 3..18
const LZ_MAX_MATCH: usize = 18;
const LZ_MAX_CHAIN: usize = 16; // 哈希链回溯上限 (控制最坏耗时)
const LZ_HASH_SIZE: usize = 1 << 16; // 3 字节前缀哈希表大小

fn lz_hash3(b: &[u8], i: usize) -> usize {
    (((b[i] as usize) << 10) ^ ((b[i + 1] as usize) << 5) ^ (b[i + 2] as usize)) & (LZ_HASH_SIZE - 1)
}

fn lz_insert_at(input: &[u8], pos: usize, head: &mut [i32], prev: &mut [i32]) {
    if pos + LZ_MIN_MATCH > input.len() {
        return;
    }
    let h = lz_hash3(input, pos);
    prev[pos] = head[h];
    head[h] = pos as i32;
}

/// 哈希链查最长匹配 (窗口内; 够不上 MIN_MATCH 就当没匹配)
fn lz_find_match(input: &[u8], pos: usize, head: &[i32], prev: &[i32]) -> Option<(usize, usize)> {
    if pos + LZ_MIN_MATCH > input.len() {
        return None;
    }
    let h = lz_hash3(input, pos);
    let max_len = LZ_MAX_MATCH.min(input.len() - pos);
    let mut cand = head[h];
    let mut chain = 0;
    let mut best_len = 0usize;
    let mut best_off = 0usize;
    while cand >= 0 && chain < LZ_MAX_CHAIN {
        let distance = pos - cand as usize;
        if distance > LZ_WINDOW {
            break;
        }
        let mut len = 0usize;
        while len < max_len && input[cand as usize + len] == input[pos + len] {
            len += 1;
        }
        if len > best_len {
            best_len = len;
            best_off = distance;
            if len == max_len {
                break;
            }
        }
        cand = prev[cand as usize];
        chain += 1;
    }
    if best_len >= LZ_MIN_MATCH {
        Some((best_off, best_len))
    } else {
        None
    }
}

/// LZ77 压缩 → `[varint origLen][varint compLen][token stream]`
///
/// token stream = 控制字节 + 载荷, 每控制字节管 8 个 token (MSB 在前):
/// 控制位 0 → 后接 1 字节字面量; 控制位 1 → 后接 2 字节匹配 (12 位 offset, 4 位 length-3)。
///
/// 诚实边界: 窗口 4095B / 最短匹配 3B / 最长匹配 18B, **没有**哈夫曼那一层;
/// 对重复度高的结构化文本有效, 对**随机字节**会膨胀 (控制位占 1/8)。
pub fn lz77_compress(input: &[u8]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    // 头: origLen + compLen 占位 (varint(0) = 1B, 最后整体重拼, 不依赖占位宽度)
    write_varint(&mut out, input.len() as u32);
    write_varint(&mut out, 0);
    let body_start = out.len();

    let mut head = vec![-1i32; LZ_HASH_SIZE];
    let mut prev = vec![-1i32; input.len()];

    let mut i = 0usize;
    while i < input.len() {
        let control_idx = out.len();
        out.push(0);
        let mut control = 0u8;
        let mut bit: i32 = 7;
        while bit >= 0 && i < input.len() {
            if let Some((offset, len)) = lz_find_match(input, i, &head, &prev) {
                control |= 1 << bit;
                let v = ((offset & 0xfff) << 4) | ((len - LZ_MIN_MATCH) & 0xf);
                out.push((v >> 8) as u8);
                out.push((v & 0xff) as u8);
                for k in 0..len {
                    lz_insert_at(input, i + k, &mut head, &mut prev);
                }
                i += len;
            } else {
                out.push(input[i]);
                lz_insert_at(input, i, &mut head, &mut prev);
                i += 1;
            }
            bit -= 1;
        }
        out[control_idx] = control;
    }

    // compLen = 占位之后的码流字节数 (把占位字节算进去 ⇒ 声明比实际多 ⇒ 解码必报截断)
    let body = out[body_start..].to_vec();
    let mut filled: Vec<u8> = Vec::with_capacity(body.len() + 8);
    write_varint(&mut filled, input.len() as u32);
    write_varint(&mut filled, body.len() as u32);
    filled.extend_from_slice(&body);
    filled
}

/// LZ77 解压 (严格): 码流不足 / 长度对不上 / offset 越界一律报错, 不做任何"尽量解"
pub fn lz77_decompress(block: &[u8]) -> Result<Vec<u8>, EfficodeError> {
    let mut pos = 0usize;
    let orig_len = read_varint(block, &mut pos)? as usize;
    let comp_len = read_varint(block, &mut pos)? as usize;
    let body_end = pos + comp_len;
    if body_end > block.len() {
        return Err(EfficodeError::Truncated(
            format!("LZ77 码流声明 {comp_len}B 但只剩 {}B", block.len() - pos),
            pos,
        ));
    }
    let mut out: Vec<u8> = Vec::with_capacity(orig_len);
    while out.len() < orig_len {
        if pos >= body_end {
            return Err(EfficodeError::Truncated(
                format!("LZ77 码流提前结束 (期望 {orig_len}B, 实得 {}B)", out.len()),
                pos,
            ));
        }
        let control = block[pos];
        pos += 1;
        let mut bit: i32 = 7;
        while bit >= 0 && out.len() < orig_len {
            if control & (1 << bit) != 0 {
                if pos + 2 > body_end {
                    return Err(EfficodeError::Truncated("LZ77 匹配 token 缺字节".into(), pos));
                }
                let v = ((block[pos] as usize) << 8) | block[pos + 1] as usize;
                pos += 2;
                let offset = (v >> 4) & 0xfff;
                let length = (v & 0xf) + LZ_MIN_MATCH;
                if offset == 0 || offset > out.len() {
                    return Err(EfficodeError::Truncated(
                        format!("LZ77 匹配 offset={offset} 越界 (已解 {}B)", out.len()),
                        pos,
                    ));
                }
                for _ in 0..length {
                    let b = out[out.len() - offset];
                    out.push(b);
                }
            } else {
                if pos >= body_end {
                    return Err(EfficodeError::Truncated("LZ77 字面量 token 缺字节".into(), pos));
                }
                out.push(block[pos]);
                pos += 1;
            }
            bit -= 1;
        }
    }
    Ok(out)
}

/// 压缩成完整数据块: `[1B 算法 id][载荷]`
pub fn compress_block(raw: &[u8], algo: CompressionAlgo) -> Vec<u8> {
    let mut out = vec![algo.id()];
    match algo {
        CompressionAlgo::None => out.extend_from_slice(raw),
        CompressionAlgo::Lz77 => out.extend_from_slice(&lz77_compress(raw)),
    }
    out
}

/// 解压 `[1B 算法 id][载荷]`: 未知算法 id → 报错, 绝不"跳过解压直接给原文"
pub fn decompress_block(block: &[u8]) -> Result<(CompressionAlgo, Vec<u8>), EfficodeError> {
    let Some(&id) = block.first() else {
        return Err(EfficodeError::Truncated("数据块空 (缺算法 id)".into(), 0));
    };
    let algo = CompressionAlgo::from_id(id).ok_or_else(|| {
        EfficodeError::UnknownCompression(format!("数据块声明未知压缩算法 id={id}"))
    })?;
    let payload = &block[1..];
    Ok(match algo {
        CompressionAlgo::None => (algo, payload.to_vec()),
        CompressionAlgo::Lz77 => (algo, lz77_decompress(payload)?),
    })
}

/// 默认算法选择: <32B 不压 (开箱代价 > 收益); 压完**连算法 id 一起**不小于原样就退回 none
pub fn pick_algo(raw: &[u8]) -> CompressionAlgo {
    if raw.len() < 32 {
        return CompressionAlgo::None;
    }
    if lz77_compress(raw).len() + 1 < raw.len() {
        CompressionAlgo::Lz77
    } else {
        CompressionAlgo::None
    }
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

    // 数据块: [1B 算法 id][载荷] —— 算法 id 永远写, 解码端按 id 解, 不猜
    let mut compressed = false;
    let data_block = msg.data.as_deref().map(|data| {
        let algo = msg.compression.unwrap_or_else(|| pick_algo(data));
        if algo != CompressionAlgo::None {
            compressed = true;
        }
        compress_block(data, algo)
    });
    let has_data = data_block.is_some();
    if let Some(block) = &data_block {
        write_varint(&mut body, block.len() as u32);
        body.extend_from_slice(block);
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
    // F_COMPRESSED: 只有真走了压缩路径才置位 (没压就如实标 0)
    if compressed {
        flags |= F_COMPRESSED;
    }
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

    // 数据块 (按算法 id 解压; 未知 id / 码流不足一律报错, 不给原文)
    let data = if flags & F_HAS_DATA != 0 {
        let data_len = read_varint(rest, &mut pos)? as usize;
        if pos + data_len > rest.len() {
            return Err(EfficodeError::Truncated("数据块长度超出".into(), pos));
        }
        let (_, raw) = decompress_block(&rest[pos..pos + data_len])?;
        pos += data_len;
        Some(raw)
    } else {
        None
    };

    // 逐段自描述: 解析结束位置必须正好落在 CRC 段起点
    // (中间有垃圾 = 报错, 不许"能解多少解多少" —— 对齐 TS EFFICODE_TRAILING_BYTES)
    if pos != rest.len() {
        return Err(EfficodeError::Truncated(
            format!("解析在 {pos}B 结束, 但段总长 {}B —— 中间有 {}B 垃圾", rest.len(), rest.len() - pos),
            pos,
        ));
    }

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
            compression: None,
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
    fn lz77_roundtrip_and_truncation_rejected() {
        let raw: Vec<u8> = b"abababababababababab".to_vec().repeat(10);
        let comp = lz77_compress(&raw);
        assert!(comp.len() < raw.len(), "重复文本真压得动: {} < {}", comp.len(), raw.len());
        assert_eq!(lz77_decompress(&comp).unwrap(), raw, "解压逐字节还原");
        assert!(
            lz77_decompress(&comp[..comp.len() - 1]).is_err(),
            "码流短一字节 → 报错, 不做'尽量解'"
        );
    }

    #[test]
    fn compressed_data_block_roundtrip() {
        let mut msg = sample_msg();
        msg.data = Some("同一句话重复很多次, 同一句话重复很多次。".as_bytes().to_vec().repeat(12));
        let bytes = encode(&msg).unwrap();
        assert_ne!(bytes[1] & F_COMPRESSED, 0, "压得动 → 压缩位置起");
        let pkt = decode(&bytes).unwrap();
        assert_eq!(pkt.data.as_deref(), msg.data.as_deref(), "解压后与原文逐字节一致");

        // 同消息强制不压 → 包更大 (压缩省下的字节是真数字, 不是声明)
        let mut plain = msg.clone();
        plain.compression = Some(CompressionAlgo::None);
        let plain_bytes = encode(&plain).unwrap();
        assert_eq!(plain_bytes[1] & F_COMPRESSED, 0, "没压就如实标 0");
        assert!(bytes.len() < plain_bytes.len(), "压缩后真的小于原样: {} vs {}", bytes.len(), plain_bytes.len());
    }

    #[test]
    fn unknown_compression_id_rejected() {
        // 未知算法 id (deflate=2 本参考实现不做) → 报 UnknownCompression, 绝不跳过解压给原文
        assert!(matches!(
            decompress_block(&[2, 1, 2, 3]).unwrap_err(),
            EfficodeError::UnknownCompression(_)
        ));
        // 空数据块 = 缺算法 id → 截断
        assert!(matches!(decompress_block(&[]).unwrap_err(), EfficodeError::Truncated(..)));
        // 小消息不压 (开箱代价 > 收益)
        assert_eq!(pick_algo(b"short"), CompressionAlgo::None);
        assert_eq!(pick_algo(&b"x".to_vec().repeat(200)), CompressionAlgo::Lz77);
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
            compression: None,
            mode: EfficodeMode::Compact,
        };
        let bytes = encode(&msg).unwrap();
        // 帧头2 + did32 + opLen varint + 指令 + dataLen varint + 20 + crc4
        assert!(bytes.len() >= 32 + 20 + 8, "帧开销真实存在, 诚实记录不吹");
    }
}
