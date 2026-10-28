//! 眼镜端语音入口 — POST /api/asr
//!
//! 眼镜（YodaOS-Sprite / AOSP）没有可用系统 ASR：`android.speech` 的
//! RecognitionService 在本机不存在，Rokid 的 AIUIService 又是 signature 权限。
//! 所以眼镜只负责录音，转写交给 bolloon 节点：眼镜把 16k/mono/16bit WAV
//! 原始字节 POST 到这里，节点调本机 whisper.cpp 转成文本返回。
//!
//! 约定（都可用环境变量覆盖，默认指向 ~/.bolloon/asr）：
//! - BOLLOON_ASR_BIN   whisper-cli 可执行文件（默认 ~/.bolloon/asr/bin/whisper-cli）
//! - BOLLOON_ASR_MODEL ggml 模型路径（默认 ~/.bolloon/asr/models/ggml-base.bin）
//! - BOLLOON_ASR_LANG  语言（默认 zh）
//!
//! 没装 whisper 时返回明确的结构化错误，而不是假装识别成功。

use std::path::PathBuf;
use std::time::Duration;

use axum::body::Bytes;
use axum::Json;

fn home() -> PathBuf {
    std::env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("."))
}

fn asr_bin() -> PathBuf {
    std::env::var("BOLLOON_ASR_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home().join(".bolloon/asr/bin/whisper-cli"))
}

fn asr_model() -> PathBuf {
    std::env::var("BOLLOON_ASR_MODEL")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home().join(".bolloon/asr/models/ggml-base.bin"))
}

fn asr_lang() -> String {
    std::env::var("BOLLOON_ASR_LANG").unwrap_or_else(|_| "zh".to_string())
}

/// POST /api/asr  (Content-Type: audio/wav, body = 完整 WAV)
/// → { ok, text, ms } 或 { ok:false, error, hint }
pub async fn asr(body: Bytes) -> Json<serde_json::Value> {
    let started = std::time::Instant::now();
    if body.is_empty() {
        return Json(serde_json::json!({
            "ok": false, "text": "", "error": "empty body",
            "hint": "眼镜端应 POST 完整 WAV (16kHz/mono/16bit)"
        }));
    }

    let bin = asr_bin();
    let model = asr_model();
    if !bin.exists() {
        return Json(serde_json::json!({
            "ok": false, "text": "",
            "error": format!("whisper-cli 不存在: {}", bin.display()),
            "hint": "设 BOLLOON_ASR_BIN，或跑 scripts/setup-asr.sh 安装 whisper.cpp"
        }));
    }
    if !model.exists() {
        return Json(serde_json::json!({
            "ok": false, "text": "",
            "error": format!("模型不存在: {}", model.display()),
            "hint": "设 BOLLOON_ASR_MODEL，或跑 scripts/setup-asr.sh 下载 ggml 模型"
        }));
    }

    // 落临时文件（whisper-cli 只吃文件路径）
    let dir = std::env::temp_dir().join("bolloon-asr");
    let _ = std::fs::create_dir_all(&dir);
    let wav_path = dir.join(format!(
        "asr-{}-{}.wav",
        std::process::id(),
        chrono::Utc::now().timestamp_millis()
    ));
    if let Err(e) = std::fs::write(&wav_path, &body) {
        return Json(serde_json::json!({
            "ok": false, "text": "",
            "error": format!("写临时文件失败: {e}")
        }));
    }

    let output = tokio::time::timeout(
        Duration::from_secs(90),
        tokio::process::Command::new(&bin)
            .arg("-m").arg(&model)
            .arg("-f").arg(&wav_path)
            .arg("-l").arg(asr_lang())
            .arg("-nt")   // 不要时间戳
            .arg("-np")   // 不要进度/系统信息
            .output(),
    )
    .await;

    let _ = std::fs::remove_file(&wav_path);

    let text = match output {
        Err(_) => {
            return Json(serde_json::json!({
                "ok": false, "text": "", "error": "whisper 超时 (90s)"
            }))
        }
        Ok(Err(e)) => {
            return Json(serde_json::json!({
                "ok": false, "text": "", "error": format!("启动 whisper 失败: {e}")
            }))
        }
        Ok(Ok(out)) => {
            if !out.status.success() {
                let stderr = String::from_utf8_lossy(&out.stderr);
                return Json(serde_json::json!({
                    "ok": false, "text": "",
                    "error": format!("whisper 退出码 {:?}", out.status.code()),
                    "stderr": stderr.chars().take(400).collect::<String>()
                }));
            }
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(|l| l.trim())
                .filter(|l| !l.is_empty() && !l.starts_with('['))
                .collect::<Vec<_>>()
                .join(" ")
        }
    };

    Json(serde_json::json!({
        "ok": true,
        "text": text,
        "ms": started.elapsed().as_millis() as u64,
    }))
}
