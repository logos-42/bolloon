//! 眼镜端「扫一眼」视觉入口 — POST /api/vision
//!
//! 眼镜拍一张 → 这里离线 OCR（macOS Vision）→ 得到画面里的文字 →
//! 与节点上已有的意图（/api/intents）做词面匹配 → 返回：
//!   { ok, text, intent:{tag,...}|null, hint }
//!
//! 为什么 OCR 而不是视觉大模型：当前节点的 LLM 提供商（deepseek-chat）不吃图，
//! 而 Vision 的离线文字识别不要 key、不要联网、中文够准 —— 先让链路真的通，
//! 视觉模型接进来时只需换 ocr_text() 的实现。
//!
//! 环境变量：
//! - BOLLOON_OCR_BIN  默认 ~/.bolloon/bin/vision-ocr（scripts/setup-ocr.sh 编译）

use std::path::PathBuf;
use std::time::Duration;

use axum::Json;
use serde::Deserialize;

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
pub async fn vision(Json(req): Json<VisionRequest>) -> Json<serde_json::Value> {
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

    let intent = match_intent(&text, req.intents.as_deref());
    Json(serde_json::json!({
        "ok": true,
        "text": text,
        "intent": intent,
        "hint": intent
            .as_ref()
            .map(|i| format!("匹配到意图「{i}」，机会卡片已按它刷新"))
            .unwrap_or_else(|| "没匹配到已有意图，已按画面文字刷新机会".to_string()),
    }))
}

/// 词面匹配：把意图标签和画面文字做最长公共 token 命中。
/// 不调 LLM —— 快、可解释、没网也能用；真接了视觉模型再换这里。
fn match_intent(text: &str, intents: Option<&[String]>) -> Option<String> {
    let pool: Vec<String> = match intents {
        Some(list) if !list.is_empty() => list.to_vec(),
        _ => default_intents(),
    };
    let hay = text.to_lowercase();
    let mut best: Option<(usize, String)> = None;
    for tag in pool {
        let t = tag.trim();
        if t.is_empty() {
            continue;
        }
        let tl = t.to_lowercase();
        // 整词命中优先，其次逐字命中数
        if hay.contains(&tl) {
            let score = tl.chars().count() + 100;
            if best.as_ref().map(|(s, _)| score > *s).unwrap_or(true) {
                best = Some((score, t.to_string()));
            }
        } else {
            let hits = tl
                .chars()
                .filter(|c| !c.is_whitespace() && hay.contains(*c))
                .count();
            if hits >= 2
                && best.as_ref().map(|(s, _)| hits > *s).unwrap_or(true)
            {
                best = Some((hits, t.to_string()));
            }
        }
    }
    best.map(|(_, t)| t)
}

fn default_intents() -> Vec<String> {
    [
        "可控核聚变", "合作招募", "招聘", "采购", "报价", "发票", "海关", "防火", "监理",
        "翻译", "会议", "路演", "投资", "论文", "项目",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}
