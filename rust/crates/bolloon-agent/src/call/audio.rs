//! 音频基础层：WAV 读写 / 重采样 / 能量 VAD / 半双工门。
//!
//! 全部是纯函数或纯内存操作，不依赖外部 crate，也不碰硬件。
//! 支持的格式：**16-bit PCM 单声道/多声道 WAV**；8/24/32-bit 与浮点明确报错。

use serde::{Deserialize, Serialize};

/// 一段 16-bit PCM 音频
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Pcm16 {
    pub sample_rate: u32,
    /// 交错多声道样本（单声道时即线性）
    pub samples: Vec<i16>,
    pub channels: u16,
}

impl Pcm16 {
    pub fn mono(sample_rate: u32, samples: Vec<i16>) -> Self {
        Self { sample_rate, samples, channels: 1 }
    }

    pub fn frames(&self) -> usize {
        let ch = self.channels.max(1) as usize;
        self.samples.len() / ch
    }

    pub fn duration_ms(&self) -> u64 {
        if self.sample_rate == 0 {
            return 0;
        }
        (self.frames() as u64 * 1000) / self.sample_rate as u64
    }

    pub fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }

    /// 均方根（归一化到 0..1）
    pub fn rms(&self) -> f32 {
        if self.samples.is_empty() {
            return 0.0;
        }
        let sum: f64 = self.samples.iter().map(|&s| (s as f64) * (s as f64)).sum();
        let mean = sum / self.samples.len() as f64;
        (mean.sqrt() / i16::MAX as f64) as f32
    }

    /// 取单声道视图（多声道取平均）
    pub fn to_mono(&self) -> Pcm16 {
        if self.channels <= 1 {
            return self.clone();
        }
        let ch = self.channels as usize;
        let mut out = Vec::with_capacity(self.frames());
        for f in self.samples.chunks(ch) {
            let sum: i32 = f.iter().map(|&s| s as i32).sum();
            out.push((sum / ch as i32) as i16);
        }
        Pcm16::mono(self.sample_rate, out)
    }
}

/// 解析 WAV（只认 16-bit PCM）
pub fn parse_wav(bytes: &[u8]) -> Result<Pcm16, String> {
    if bytes.len() < 44 {
        return Err("WAV 太短".into());
    }
    if &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("不是 RIFF/WAVE".into());
    }

    let mut pos = 12usize;
    let mut fmt: Option<(u16, u16, u32, u16)> = None; // (format, channels, rate, bits)
    let mut data: Option<&[u8]> = None;

    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32::from_le_bytes([
            bytes[pos + 4],
            bytes[pos + 5],
            bytes[pos + 6],
            bytes[pos + 7],
        ]) as usize;
        let body = pos + 8;
        let end = body.saturating_add(size).min(bytes.len());

        match id {
            b"fmt " => {
                if end - body < 16 {
                    return Err("fmt 块太短".into());
                }
                let format = u16::from_le_bytes([bytes[body], bytes[body + 1]]);
                let channels = u16::from_le_bytes([bytes[body + 2], bytes[body + 3]]);
                let rate = u32::from_le_bytes([
                    bytes[body + 4],
                    bytes[body + 5],
                    bytes[body + 6],
                    bytes[body + 7],
                ]);
                let bits = u16::from_le_bytes([bytes[body + 14], bytes[body + 15]]);
                fmt = Some((format, channels, rate, bits));
            }
            b"data" => data = Some(&bytes[body..end]),
            _ => {}
        }
        // chunk 按 2 字节对齐
        pos = body + size + (size & 1);
    }

    let (format, channels, sample_rate, bits) =
        fmt.ok_or_else(|| "WAV 缺 fmt 块".to_string())?;
    if format != 1 {
        return Err(format!("只支持 PCM(format=1)，当前 {format}"));
    }
    if bits != 16 {
        return Err(format!("只支持 16-bit，当前 {bits}-bit"));
    }
    if channels == 0 {
        return Err("声道数为 0".into());
    }
    let data = data.ok_or_else(|| "WAV 缺 data 块".to_string())?;

    let samples: Vec<i16> = data
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect();

    Ok(Pcm16 { sample_rate, samples, channels })
}

/// 生成标准 44 字节头的 16-bit PCM WAV
pub fn encode_wav(pcm: &Pcm16) -> Vec<u8> {
    let channels = pcm.channels.max(1);
    let bits: u16 = 16;
    let byte_rate = pcm.sample_rate * channels as u32 * (bits as u32 / 8);
    let block_align = channels * (bits / 8);
    let data_len = (pcm.samples.len() * 2) as u32;

    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&pcm.sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&bits.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in &pcm.samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

/// 线性插值重采样（单声道语义；多声道按帧处理）
pub fn resample(pcm: &Pcm16, target_rate: u32) -> Pcm16 {
    if pcm.sample_rate == target_rate || pcm.sample_rate == 0 || pcm.is_empty() {
        return pcm.clone();
    }
    let ch = pcm.channels.max(1) as usize;
    let src_frames = pcm.frames();
    if src_frames < 2 {
        return pcm.clone();
    }
    let ratio = target_rate as f64 / pcm.sample_rate as f64;
    let dst_frames = ((src_frames as f64) * ratio).round().max(1.0) as usize;

    let mut out = Vec::with_capacity(dst_frames * ch);
    for i in 0..dst_frames {
        let src_pos = i as f64 / ratio;
        let i0 = src_pos.floor() as usize;
        let i1 = (i0 + 1).min(src_frames - 1);
        let frac = src_pos - i0 as f64;
        for c in 0..ch {
            let a = pcm.samples[i0 * ch + c] as f64;
            let b = pcm.samples[i1 * ch + c] as f64;
            let v = a + (b - a) * frac;
            out.push(v.round().clamp(i16::MIN as f64, i16::MAX as f64) as i16);
        }
    }
    Pcm16 { sample_rate: target_rate, samples: out, channels: pcm.channels }
}

/// VAD 配置（能量门限为归一化 RMS）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VadConfig {
    /// 低于此 RMS 视为静音（默认 0.012 ≈ -38 dBFS）
    pub silence_rms: f32,
    /// 最短语音段（毫秒），更短的丢弃
    pub min_speech_ms: u64,
    /// 允许的段内静音（毫秒），用于合并同一句话
    pub max_gap_ms: u64,
    /// 分帧长度（毫秒）
    pub frame_ms: u64,
}

impl Default for VadConfig {
    fn default() -> Self {
        Self { silence_rms: 0.012, min_speech_ms: 200, max_gap_ms: 400, frame_ms: 20 }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    pub start_ms: u64,
    pub end_ms: u64,
    pub pcm: Pcm16,
}

/// 能量 VAD：按帧判定语音，合并间隙，丢弃过短段。
///
/// 已知局限（如实）：这是**能量门限**，不是神经网络 VAD；持续背景噪音会误判。
pub fn segment(pcm: &Pcm16, cfg: &VadConfig) -> Vec<Segment> {
    let mono = pcm.to_mono();
    if mono.is_empty() || mono.sample_rate == 0 {
        return vec![];
    }
    let frame_len = ((mono.sample_rate as u64 * cfg.frame_ms) / 1000).max(1) as usize;
    let mut flags: Vec<bool> = Vec::new();
    for chunk in mono.samples.chunks(frame_len) {
        let seg = Pcm16::mono(mono.sample_rate, chunk.to_vec());
        flags.push(seg.rms() >= cfg.silence_rms);
    }

    let mut regions: Vec<(usize, usize)> = Vec::new();
    let mut cur: Option<usize> = None;
    for (i, &speech) in flags.iter().enumerate() {
        match (speech, cur) {
            (true, None) => cur = Some(i),
            (false, Some(start)) => {
                regions.push((start, i));
                cur = None;
            }
            _ => {}
        }
    }
    if let Some(start) = cur {
        regions.push((start, flags.len()));
    }

    // 合并间隙小于 max_gap_ms 的相邻段
    let gap_frames = (cfg.max_gap_ms / cfg.frame_ms.max(1)) as usize;
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for r in regions {
        match merged.last_mut() {
            Some(last) if r.0.saturating_sub(last.1) <= gap_frames => last.1 = r.1,
            _ => merged.push(r),
        }
    }

    let ms_per_frame = cfg.frame_ms;
    let mut out = Vec::new();
    for (start, end) in merged {
        let dur = (end - start) as u64 * ms_per_frame;
        if dur < cfg.min_speech_ms {
            continue;
        }
        let s0 = start * frame_len;
        let s1 = (end * frame_len).min(mono.samples.len());
        if s1 <= s0 {
            continue;
        }
        out.push(Segment {
            start_ms: start as u64 * ms_per_frame,
            end_ms: end as u64 * ms_per_frame,
            pcm: Pcm16::mono(mono.sample_rate, mono.samples[s0..s1].to_vec()),
        });
    }
    out
}

/// 半双工门 + 打断检测。
///
/// 语义：播放（AI 说话）期间不采集，避免把自己的声音当成对方；
/// 若在播放中检测到**足够强的**语音，视为打断（barge-in），调用方应停止播放。
#[derive(Debug, Default)]
pub struct HalfDuplex {
    speaking: std::sync::atomic::AtomicBool,
}

impl HalfDuplex {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn begin_speaking(&self) {
        self.speaking.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn end_speaking(&self) {
        self.speaking.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn is_speaking(&self) -> bool {
        self.speaking.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// 是否应该采集（播放中 = 不采集）
    pub fn should_capture(&self) -> bool {
        !self.is_speaking()
    }

    /// 播放中检测到语音 ⇒ 应打断
    pub fn detect_barge_in(&self, pcm: &Pcm16, cfg: &VadConfig) -> bool {
        if !self.is_speaking() {
            return false;
        }
        !segment(pcm, cfg).is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(rate: u32, ms: u64, amp: f32) -> Pcm16 {
        let n = (rate as u64 * ms / 1000) as usize;
        let a = (i16::MAX as f32 * amp) as i16;
        Pcm16::mono(rate, vec![a; n])
    }

    fn silence(rate: u32, ms: u64) -> Pcm16 {
        let n = (rate as u64 * ms / 1000) as usize;
        Pcm16::mono(rate, vec![0i16; n])
    }

    #[test]
    fn wav_roundtrip() {
        let pcm = tone(16000, 100, 0.5);
        let bytes = encode_wav(&pcm);
        let back = parse_wav(&bytes).unwrap();
        assert_eq!(back.sample_rate, 16000);
        assert_eq!(back.channels, 1);
        assert_eq!(back.samples, pcm.samples);
        assert_eq!(back.duration_ms(), 100);
    }

    #[test]
    fn rejects_non_16bit_and_non_riff() {
        let mut bytes = encode_wav(&tone(8000, 10, 0.1));
        bytes[34] = 8; // bits = 8
        assert!(parse_wav(&bytes).unwrap_err().contains("16-bit"), "只认 16-bit");

        assert!(parse_wav(b"not a wav file at all..................").is_err());
    }

    #[test]
    fn resample_changes_rate_and_keeps_duration() {
        let pcm = tone(16000, 500, 0.3);
        let out = resample(&pcm, 8000);
        assert_eq!(out.sample_rate, 8000);
        let d = out.duration_ms() as i64 - 500;
        assert!(d.abs() <= 2, "时长应保持, got {}", out.duration_ms());
    }

    #[test]
    fn vad_splits_speech_with_silence_gap() {
        // 300ms 语音 + 1s 静音 + 300ms 语音
        let mut all = tone(16000, 300, 0.5).samples;
        all.extend(silence(16000, 1000).samples);
        all.extend(tone(16000, 300, 0.5).samples);
        let pcm = Pcm16::mono(16000, all);
        let segs = segment(&pcm, &VadConfig::default());
        assert_eq!(segs.len(), 2, "两段语音应被切开: {:?}", segs);
        assert!(segs[0].start_ms <= 20);
    }

    #[test]
    fn vad_merges_short_gap() {
        // 100ms 语音 + 100ms 静音 + 100ms 语音 ⇒ gap < max_gap 合并为一段
        let mut all = tone(16000, 100, 0.5).samples;
        all.extend(silence(16000, 100).samples);
        all.extend(tone(16000, 100, 0.5).samples);
        let pcm = Pcm16::mono(16000, all);
        let segs = segment(&pcm, &VadConfig::default());
        assert_eq!(segs.len(), 1, "短间隙应合并");
    }

    #[test]
    fn vad_drops_too_short_speech() {
        let pcm = tone(16000, 50, 0.5);
        let segs = segment(&pcm, &VadConfig::default());
        assert!(segs.is_empty(), "50ms 短于 min_speech_ms 200");
    }

    #[test]
    fn half_duplex_blocks_capture_while_speaking() {
        let hd = HalfDuplex::new();
        assert!(hd.should_capture());
        hd.begin_speaking();
        assert!(!hd.should_capture(), "播放中不采集");
        hd.end_speaking();
        assert!(hd.should_capture());
    }

    #[test]
    fn barge_in_only_while_speaking() {
        let hd = HalfDuplex::new();
        let speech = tone(16000, 300, 0.6);
        assert!(!hd.detect_barge_in(&speech, &VadConfig::default()), "没在播放就谈不上打断");
        hd.begin_speaking();
        assert!(hd.detect_barge_in(&speech, &VadConfig::default()));
        assert!(!hd.detect_barge_in(&silence(16000, 300), &VadConfig::default()));
    }

    #[test]
    fn stereo_to_mono_averages() {
        let pcm = Pcm16 { sample_rate: 8000, samples: vec![100, 300, -100, -300], channels: 2 };
        let mono = pcm.to_mono();
        assert_eq!(mono.samples, vec![200, -200]);
    }
}
