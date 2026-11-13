//! 实时语音链路：VAD 分段 → ASR → 回复 → TTS → 输出音频。
//!
//! 真实实现：本机 whisper.cpp（ASR）+ macOS `say`（TTS）。
//! 测试实现：`FixedAsr` / `EchoTts`（确定性，不依赖外部程序）。
//!
//! 诚实边界：
//! - 没有麦克风采集（这是 headless 环境）；输入是 `Pcm16`，由上层从硬件/文件喂进来。
//! - 没有真正的回声消除（AEC）：用**半双工**（播放时不采集）代替，见 `audio::HalfDuplex`。
//! - 打断（barge-in）是「播放中检测到语音 ⇒ 停止播放」，不做渐进淡出。

use std::path::PathBuf;
use std::time::{Duration, Instant};

use async_trait::async_trait;

use super::audio::{segment, HalfDuplex, Pcm16, VadConfig};

#[async_trait]
pub trait AsrPort: Send + Sync {
    fn name(&self) -> &str;
    async fn transcribe(&self, pcm: &Pcm16) -> Result<String, String>;
}

#[async_trait]
pub trait TtsPort: Send + Sync {
    fn name(&self) -> &str;
    async fn synthesize(&self, text: &str) -> Result<Pcm16, String>;
}

// ---------------------------------------------------------------------------
// 真实 ASR: whisper.cpp
// ---------------------------------------------------------------------------

pub struct WhisperAsr {
    bin: PathBuf,
    model: PathBuf,
    lang: String,
    timeout: Duration,
}

impl WhisperAsr {
    /// 默认路径与 `bolloon-web::asr` 保持一致（同一套环境变量）
    pub fn from_env() -> Self {
        let home = std::env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("."));
        let bin = std::env::var("BOLLOON_ASR_BIN")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home.join(".bolloon/asr/bin/whisper-cli"));
        let model = std::env::var("BOLLOON_ASR_MODEL")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home.join(".bolloon/asr/models/ggml-base.bin"));
        let lang = std::env::var("BOLLOON_ASR_LANG").unwrap_or_else(|_| "zh".into());
        Self { bin, model, lang, timeout: Duration::from_secs(60) }
    }

    pub fn available(&self) -> bool {
        self.bin.exists() && self.model.exists()
    }

    fn run_blocking(&self, pcm: &Pcm16) -> Result<String, String> {
        if !self.bin.exists() {
            return Err(format!("whisper-cli 不存在: {}", self.bin.display()));
        }
        if !self.model.exists() {
            return Err(format!("ASR 模型不存在: {}", self.model.display()));
        }
        // whisper 要 16k 单声道
        let mono = pcm.to_mono();
        let pcm16k = super::audio::resample(&mono, 16000);
        let dir = std::env::temp_dir().join("bolloon-voice");
        std::fs::create_dir_all(&dir).map_err(|e| format!("建临时目录失败: {e}"))?;
        let wav = dir.join(format!(
            "asr-{}-{}.wav",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::write(&wav, super::audio::encode_wav(&pcm16k))
            .map_err(|e| format!("写 WAV 失败: {e}"))?;

        let mut cmd = std::process::Command::new(&self.bin);
        // whisper.cpp 的 dylib 与二进制同目录；安装时未设 DYLD_LIBRARY_PATH，
        // 直接跑会报 "Library not loaded: @rpath/libwhisper.1.dylib"。
        if let Some(dir) = self.bin.parent() {
            let mut paths = vec![dir.to_path_buf()];
            if let Ok(existing) = std::env::var("DYLD_LIBRARY_PATH") {
                if !existing.is_empty() {
                    paths.extend(std::env::split_paths(&existing));
                }
            }
            if let Ok(joined) = std::env::join_paths(paths) {
                cmd.env("DYLD_LIBRARY_PATH", joined);
            }
        }
        let out = cmd
            .arg("-m")
            .arg(&self.model)
            .arg("-f")
            .arg(&wav)
            .arg("-l")
            .arg(&self.lang)
            .arg("-nt")
            .arg("-np")
            .output()
            .map_err(|e| format!("启动 whisper-cli 失败: {e}"))?;
        let _ = std::fs::remove_file(&wav);

        if !out.status.success() {
            return Err(format!(
                "whisper-cli 退出码 {:?}: {}",
                out.status.code(),
                String::from_utf8_lossy(&out.stderr).chars().take(300).collect::<String>()
            ));
        }
        let text = String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        Ok(text)
    }
}

#[async_trait]
impl AsrPort for WhisperAsr {
    fn name(&self) -> &str {
        "whisper.cpp"
    }

    async fn transcribe(&self, pcm: &Pcm16) -> Result<String, String> {
        let me = Self {
            bin: self.bin.clone(),
            model: self.model.clone(),
            lang: self.lang.clone(),
            timeout: self.timeout,
        };
        let audio = pcm.clone();
        tokio::time::timeout(
            me.timeout,
            tokio::task::spawn_blocking(move || me.run_blocking(&audio)),
        )
        .await
        .map_err(|_| "ASR 超时".to_string())?
        .map_err(|e| format!("ASR 线程失败: {e}"))?
    }
}

// ---------------------------------------------------------------------------
// 真实 TTS: macOS say
// ---------------------------------------------------------------------------

pub struct MacSayTts {
    voice: Option<String>,
    rate: Option<u32>,
}

impl MacSayTts {
    pub fn new() -> Self {
        Self { voice: std::env::var("BOLLOON_TTS_VOICE").ok(), rate: None }
    }

    pub fn with_rate(mut self, wpm: u32) -> Self {
        self.rate = Some(wpm);
        self
    }

    pub fn available() -> bool {
        cfg!(target_os = "macos") && PathBuf::from("/usr/bin/say").exists()
    }

    fn run_blocking(&self, text: &str) -> Result<Pcm16, String> {
        if !Self::available() {
            return Err("当前平台没有 say（TTS 未实现）".into());
        }
        let dir = std::env::temp_dir().join("bolloon-voice");
        std::fs::create_dir_all(&dir).map_err(|e| format!("建临时目录失败: {e}"))?;
        let wav = dir.join(format!(
            "tts-{}-{}.wav",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));

        let mut cmd = std::process::Command::new("/usr/bin/say");
        cmd.arg("-o").arg(&wav).arg("--data-format=LEI16@16000");
        if let Some(v) = &self.voice {
            cmd.arg("-v").arg(v);
        }
        if let Some(r) = self.rate {
            cmd.arg("-r").arg(r.to_string());
        }
        cmd.arg(text);
        let out = cmd.output().map_err(|e| format!("启动 say 失败: {e}"))?;
        if !out.status.success() {
            let _ = std::fs::remove_file(&wav);
            return Err(format!(
                "say 失败: {}",
                String::from_utf8_lossy(&out.stderr).chars().take(300).collect::<String>()
            ));
        }
        let bytes = std::fs::read(&wav).map_err(|e| format!("读 say 输出失败: {e}"))?;
        let _ = std::fs::remove_file(&wav);
        super::audio::parse_wav(&bytes)
    }
}

#[async_trait]
impl TtsPort for MacSayTts {
    fn name(&self) -> &str {
        "macos-say"
    }

    async fn synthesize(&self, text: &str) -> Result<Pcm16, String> {
        let text = text.to_string();
        let voice = self.voice.clone();
        let rate = self.rate;
        tokio::task::spawn_blocking(move || {
            MacSayTts { voice, rate }.run_blocking(&text)
        })
        .await
        .map_err(|e| format!("TTS 线程失败: {e}"))?
    }
}

// ---------------------------------------------------------------------------
// 确定性实现（测试/离线用）
// ---------------------------------------------------------------------------

pub struct FixedAsr(pub String);

#[async_trait]
impl AsrPort for FixedAsr {
    fn name(&self) -> &str {
        "fixed"
    }
    async fn transcribe(&self, _pcm: &Pcm16) -> Result<String, String> {
        Ok(self.0.clone())
    }
}

pub struct EchoTts {
    pub sample_rate: u32,
}

impl Default for EchoTts {
    fn default() -> Self {
        Self { sample_rate: 16000 }
    }
}

impl EchoTts {
    #[allow(clippy::needless_range_loop)]
    fn tone(&self, ms: u64) -> Pcm16 {
        let n = (self.sample_rate as u64 * ms / 1000) as usize;
        let mut v = Vec::with_capacity(n);
        for i in 0..n {
            let phase = (i as f32) * 440.0 * 2.0 * std::f32::consts::PI / self.sample_rate as f32;
            v.push((phase.sin() * 6000.0) as i16);
        }
        Pcm16::mono(self.sample_rate, v)
    }
}

#[async_trait]
impl TtsPort for EchoTts {
    fn name(&self) -> &str {
        "echo"
    }
    async fn synthesize(&self, text: &str) -> Result<Pcm16, String> {
        // 每个字符 60ms，至少 120ms
        let chars = text.chars().count().max(2) as u64;
        Ok(self.tone((chars * 60).clamp(120, 10_000)))
    }
}

// ---------------------------------------------------------------------------
// 一轮对话
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct VoiceTurn {
    /// 对方每段的 ASR 结果
    pub heard: Vec<String>,
    /// 每段对应的回复文本
    pub replies: Vec<String>,
    pub asr_ms: u64,
    pub reply_ms: u64,
    pub tts_ms: u64,
    pub barge_in: bool,
    /// 回复音频总时长（毫秒）
    pub output_ms: u64,
}

pub struct VoiceLoop {
    pub vad: VadConfig,
    pub half_duplex: HalfDuplex,
}

impl Default for VoiceLoop {
    fn default() -> Self {
        Self { vad: VadConfig::default(), half_duplex: HalfDuplex::new() }
    }
}

impl VoiceLoop {
    /// 处理一段输入音频：VAD 分段 → 逐段 ASR → 回复 → TTS → 拼接输出。
    ///
    /// 播放期间收到输入 ⇒ 标记 `barge_in` 并停止（半双工语义）。
    pub async fn run_turn(
        &self,
        input: &Pcm16,
        asr: &dyn AsrPort,
        tts: &dyn TtsPort,
        reply: &(dyn Fn(&str) -> String + Send + Sync),
    ) -> Result<VoiceTurn, String> {
        if !self.half_duplex.should_capture() {
            // 正在播放 → 这算打断，不是新一轮
            let mut t = VoiceTurn::default();
            t.barge_in = !segment(input, &self.vad).is_empty();
            return Ok(t);
        }

        let segs = segment(input, &self.vad);
        let mut turn = VoiceTurn::default();
        if segs.is_empty() {
            return Ok(turn);
        }

        let mut output: Vec<i16> = Vec::new();
        let mut rate = 16000u32;

        for seg in segs {
            let t0 = Instant::now();
            let text = asr.transcribe(&seg.pcm).await?;
            turn.asr_ms += t0.elapsed().as_millis() as u64;
            let text = text.trim().to_string();
            if text.is_empty() {
                continue;
            }
            turn.heard.push(text.clone());

            let t1 = Instant::now();
            let r = reply(&text);
            turn.reply_ms += t1.elapsed().as_millis() as u64;
            if r.trim().is_empty() {
                continue;
            }
            turn.replies.push(r.clone());

            // 播放前进入半双工
            self.half_duplex.begin_speaking();
            let t2 = Instant::now();
            let audio = tts.synthesize(&r).await?;
            turn.tts_ms += t2.elapsed().as_millis() as u64;
            self.half_duplex.end_speaking();

            rate = audio.sample_rate;
            output.extend_from_slice(&audio.samples);
        }

        turn.output_ms = if rate == 0 { 0 } else { (output.len() as u64 * 1000) / rate as u64 };
        Ok(turn)
    }

    /// 把合成好的回复音频落成 WAV（回放/验收用）
    pub fn render_output(&self, audio: &Pcm16) -> Vec<u8> {
        super::audio::encode_wav(audio)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::call::audio::encode_wav;

    fn speech(rate: u32, ms: u64) -> Pcm16 {
        let n = (rate as u64 * ms / 1000) as usize;
        Pcm16::mono(rate, vec![8000i16; n])
    }

    fn silence(rate: u32, ms: u64) -> Pcm16 {
        let n = (rate as u64 * ms / 1000) as usize;
        Pcm16::mono(rate, vec![0i16; n])
    }

    #[tokio::test]
    async fn deterministic_pipeline_produces_reply_audio() {
        let mut all = speech(16000, 400).samples;
        all.extend(silence(16000, 800).samples);
        all.extend(speech(16000, 400).samples);
        let input = Pcm16::mono(16000, all);

        let loop_ = VoiceLoop::default();
        let turn = loop_
            .run_turn(
                &input,
                &FixedAsr("你好，什么事？".into()),
                &EchoTts::default(),
                &|t| format!("已收到：{t}"),
            )
            .await
            .unwrap();

        assert_eq!(turn.heard.len(), 2, "两段语音应各自识别: {:?}", turn.heard);
        assert_eq!(turn.replies.len(), 2);
        assert!(turn.output_ms > 0, "必须产出可播放音频");
        assert!(!turn.barge_in);
    }

    #[tokio::test]
    async fn no_speech_means_no_reply() {
        let loop_ = VoiceLoop::default();
        let turn = loop_
            .run_turn(
                &silence(16000, 500),
                &FixedAsr("x".into()),
                &EchoTts::default(),
                &|_| "y".into(),
            )
            .await
            .unwrap();
        assert!(turn.heard.is_empty());
        assert_eq!(turn.output_ms, 0);
    }

    #[tokio::test]
    async fn speaking_blocks_new_turn_and_marks_barge_in() {
        let loop_ = VoiceLoop::default();
        loop_.half_duplex.begin_speaking();
        let turn = loop_
            .run_turn(
                &speech(16000, 400),
                &FixedAsr("打断".into()),
                &EchoTts::default(),
                &|_| "不应回复".into(),
            )
            .await
            .unwrap();
        assert!(turn.barge_in, "播放中收到语音应判为打断");
        assert!(turn.heard.is_empty(), "打断时不应再走 ASR/回复");
    }

    #[tokio::test]
    async fn output_is_valid_wav() {
        let loop_ = VoiceLoop::default();
        let pcm = EchoTts::default().synthesize("测试").await.unwrap();
        let wav = loop_.render_output(&pcm);
        let back = crate::call::audio::parse_wav(&wav).unwrap();
        assert_eq!(back.sample_rate, 16000);
        assert!(back.duration_ms() > 0);
        assert_eq!(&wav[0..4], b"RIFF");
    }

    /// 真实链路：say 生成语音 → whisper 转文本。
    /// 缺少 whisper / 非 macOS 时**跳过并说明**，不伪造通过。
    #[tokio::test]
    async fn real_say_then_whisper_roundtrip() {
        let asr = WhisperAsr::from_env();
        if !MacSayTts::available() {
            eprintln!("skip: 当前平台没有 say");
            return;
        }
        if !asr.available() {
            eprintln!(
                "skip: whisper 不可用 (bin={:?} model={:?})",
                std::env::var("BOLLOON_ASR_BIN").ok(),
                std::env::var("BOLLOON_ASR_MODEL").ok()
            );
            return;
        }

        let tts = MacSayTts::new();
        let audio = tts.synthesize("你好，这是测试。").await.unwrap();
        assert!(audio.duration_ms() > 200, "say 应产出有效音频");

        let text = asr.transcribe(&audio).await.unwrap();
        eprintln!("whisper 识别: {text:?}");
        assert!(!text.trim().is_empty(), "真实 ASR 不应返回空");
    }

    #[test]
    fn wav_encode_matches_parse() {
        let pcm = speech(8000, 50);
        let bytes = encode_wav(&pcm);
        let back = crate::call::audio::parse_wav(&bytes).unwrap();
        assert_eq!(back.samples, pcm.samples);
    }

    /// 真实一轮对话的延迟测量（消除 batch 误差）：say 合成 → whisper 识别 → 回复 → say 合成。
    /// 缺少 say / whisper 时跳过并说明, 不伪造延迟数字。
    #[tokio::test]
    async fn real_voice_loop_turn_latency() {
        if !MacSayTts::available() {
            eprintln!("skip: 当前平台没有 say");
            return;
        }
        let asr = WhisperAsr::from_env();
        if !asr.available() {
            eprintln!("skip: whisper 不可用");
            return;
        }

        let tts = MacSayTts::new();
        // 对方说一句（真实合成）
        let peer = tts.synthesize("你好，请问收货时间怎么安排？").await.unwrap();

        let loop_ = VoiceLoop::default();
        let t0 = std::time::Instant::now();
        let turn = loop_
            .run_turn(
                &peer,
                &asr,
                &tts,
                &|_| "我帮您安排在明天下午三点，可以吗？".into(),
            )
            .await
            .unwrap();
        let total_ms = t0.elapsed().as_millis() as u64;

        eprintln!(
            "真实延迟: asr={}ms reply={}ms tts={}ms total={}ms barge_in={}",
            turn.asr_ms, turn.reply_ms, turn.tts_ms, total_ms, turn.barge_in
        );
        assert_eq!(turn.heard.len(), 1, "真实识别出 1 段");
        assert!(!turn.heard[0].is_empty());
        assert!(turn.output_ms > 0, "真实合成了回复音频");
        assert!(turn.asr_ms > 0, "ASR 真实耗时(非 0)");
        assert!(turn.tts_ms > 0, "TTS 真实耗时(非 0)");
    }
}
