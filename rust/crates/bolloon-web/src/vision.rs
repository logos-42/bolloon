//! 眼镜端「扫一眼」视觉入口 — POST /api/vision
//!
//! 链路：眼镜拍一张 → 离线 OCR（macOS Vision）拿画面文字 → **AI 预测意图**（节点 LLM）
//!      → 返回 {text, intent, confidence, reason} 给眼镜刷新世界卡片。
//!
//! 关键：意图是**模型预测**出来的，不是拿已有意图列表做关键词匹配；
//! 已有意图只当"用户长期关注方向"的提示喂给模型，模型可以给出全新标签。
//!
//! 环境变量：
//! - BOLLOON_OCR_BIN  默认 ~/.bolloon/bin/vision-ocr（scripts/setup-ocr.sh 编译）

use std::path::PathBuf;
use std::time::Duration;

use axum::extract::State;
use axum::Json;
use serde::Deserialize;

use crate::server::AppState;

fn home() -> PathBuf {
    std::env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("."))
}

fn ocr_bin() -> PathBuf {
    std::env::var("BOLLOON_OCR_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home().join(".bolloon/bin/vision-ocr"))
}

#[derive(Deserialize)]
pub struct VisionRequest {
    /// 图片 base64（JPEG/PNG 都行，可带 data: 前缀）
    pub image_base64: String,
    /// 调用方可选的意图提示词（不给就用节点已有意图）
    pub intents: Option<Vec<String>>,
}

fn decode_b64(s: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let raw = s.split(",").last().unwrap_or(s).trim();
    base64::engine::general_purpose::STANDARD
        .decode(raw)
        .map_err(|e| format!("base64 解码失败: {e}"))
}

/// POST /api/vision
pub async fn vision(
    State(st): State<AppState>,
    Json(req): Json<VisionRequest>,
) -> Json<serde_json::Value> {
    let bytes = match decode_b64(&req.image_base64) {
        Ok(b) => b,
        Err(e) => return Json(serde_json::json!({ "ok": false, "error": e })),
    };
    if bytes.len() < 256 {
        return Json(serde_json::json!({ "ok": false, "error": "图片太小，可能没拍到" }));
    }
    let bin = ocr_bin();
    if !bin.exists() {
        return Json(serde_json::json!({
            "ok": false,
            "error": format!("OCR 助手不存在: {}", bin.display()),
            "hint": "跑 scripts/setup-ocr.sh（macOS Vision 离线 OCR，不要 key）"
        }));
    }

    let dir = std::env::temp_dir().join("bolloon-vision");
    let _ = std::fs::create_dir_all(&dir);
    let img_path = dir.join(format!(
        "shot-{}-{}.jpg",
        std::process::id(),
        chrono::Utc::now().timestamp_millis()
    ));
    if let Err(e) = std::fs::write(&img_path, &bytes) {
        return Json(serde_json::json!({ "ok": false, "error": format!("写临时图片失败: {e}") }));
    }

    let out = tokio::time::timeout(
        Duration::from_secs(30),
        tokio::process::Command::new(&bin).arg(&img_path).output(),
    )
    .await;
    let _ = std::fs::remove_file(&img_path);

    let text = match out {
        Err(_) => return Json(serde_json::json!({ "ok": false, "error": "OCR 超时 (30s)" })),
        Ok(Err(e)) => return Json(serde_json::json!({ "ok": false, "error": format!("启动 OCR 失败: {e}") })),
        Ok(Ok(o)) => {
            if !o.status.success() {
                let err = String::from_utf8_lossy(&o.stderr);
                return Json(serde_json::json!({
                    "ok": false, "error": format!("OCR 退出码 {:?}", o.status.code()),
                    "stderr": err.chars().take(300).collect::<String>()
                }));
            }
            String::from_utf8_lossy(&o.stdout).trim().to_string()
        }
    };

    if text.is_empty() {
        return Json(serde_json::json!({
            "ok": true, "text": "", "intent": null,
            "hint": "画面里没认出文字 —— 对准有文字的地方（单据/招牌/屏幕）再试"
        }));
    }

    // ② AI 预测意图（模型判断"用户此刻想做什么"，不是关键词匹配）
    let focus = req
        .intents
        .as_ref()
        .map(|v| v.join("、"))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "（暂无）".to_string());

    let prompt = format!(
        "你是眼镜上的意图预测器。下面是从用户眼前画面里 OCR 出来的文字。\n\
         请预测用户此刻最可能想做什么，输出一个简短中文意图（2-6 个字，可以是全新的词，不要硬套参考列表）。\n\
         只输出一行 JSON：{{\"intent\":\"...\",\"confidence\":0到1的小数,\"reason\":\"不超过20字\"}}\n\
         参考（用户长期关注的方向，仅供理解语境）：{focus}\n\
         画面文字：\n{text}"
    );

    let raw = match crate::native::reply_with_model(&st, &prompt, None).await {
        Ok(r) => r,
        Err(e) => {
            return Json(serde_json::json!({
                "ok": true, "text": text, "intent": null, "confidence": 0.0,
                "source": "llm-unavailable", "error": e,
                "hint": "OCR 成功但模型不可用（检查 provider/key）；意图未预测，不冒充匹配成功"
            }))
        }
    };

    let (intent, confidence, reason) = parse_prediction(&raw);
    Json(serde_json::json!({
        "ok": true,
        "text": text,
        "intent": if intent.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(intent.clone()) },
        "confidence": confidence,
        "reason": reason,
        "source": "llm",
        "raw": raw.chars().take(300).collect::<String>(),
        "hint": if intent.is_empty() {
            "模型没给出明确意图".to_string()
        } else {
            format!("AI 预判意图「{intent}」")
        }
    }))
}

/// 从模型回复里抠出 {intent, confidence, reason}（容忍 ```json 包裹与前后废话）
fn parse_prediction(raw: &str) -> (String, f64, String) {
    let cleaned = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    if let (Some(s), Some(e)) = (cleaned.find('{'), cleaned.rfind('}')) {
        if e > s {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&cleaned[s..=e]) {
                let intent = v
                    .get("intent")
                    .and_then(|x| x.as_str())
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                let conf = v
                    .get("confidence")
                    .and_then(|x| x.as_f64())
                    .or_else(|| {
                        v.get("confidence")
                            .and_then(|x| x.as_str())
                            .and_then(|s| s.parse::<f64>().ok())
                    })
                    .unwrap_or(0.0)
                    .clamp(0.0, 1.0);
                let reason = v
                    .get("reason")
                    .and_then(|x| x.as_str())
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                return (intent, conf, reason);
            }
        }
    }
    // 模型没按 JSON 回：原文当意图用，但置信度 0，并标明未按格式回答
    (cleaned.chars().take(12).collect::<String>(), 0.0, "模型未按 JSON 回答".into())
}


/// 二维码解码（同一支 macOS Vision 助手，`--qr` 模式走条码检测）
///
/// 眼镜端没有可用的条码库：拍照 → 节点解码 → 回码。与 OCR 同一条链路，
/// 所以 `scripts/setup-ocr.sh` 编出来的 `~/.bolloon/bin/vision-ocr` 两个模式都能跑。
pub async fn qr_decode(bytes: &[u8]) -> Result<String, String> {
    let bin = ocr_bin();
    if !bin.exists() {
        return Err(format!(
            "条码解码助手不存在: {}（跑 scripts/setup-ocr.sh）",
            bin.display()
        ));
    }
    let dir = std::env::temp_dir().join("bolloon-vision");
    std::fs::create_dir_all(&dir).map_err(|e| format!("建临时目录失败: {e}"))?;
    let img_path = dir.join(format!(
        "qr-{}-{}.jpg",
        std::process::id(),
        chrono::Utc::now().timestamp_millis()
    ));
    std::fs::write(&img_path, bytes).map_err(|e| format!("写临时图片失败: {e}"))?;

    let out = tokio::time::timeout(
        Duration::from_secs(20),
        tokio::process::Command::new(&bin).arg("--qr").arg(&img_path).output(),
    )
    .await;
    let _ = std::fs::remove_file(&img_path);

    match out {
        Err(_) => Err("条码解码超时 (20s)".into()),
        Ok(Err(e)) => Err(format!("启动解码助手失败: {e}")),
        Ok(Ok(o)) => {
            let text = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !o.status.success() || text.is_empty() {
                // 退出码 4 = 画面里没有二维码（正常情况，不是错误）
                return Err("画面里没找到二维码".into());
            }
            Ok(text)
        }
    }
}
