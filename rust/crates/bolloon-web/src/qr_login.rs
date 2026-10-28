//! 眼镜登录（二维码扫码 / 手机授权）— `GET /login` + `/api/auth/**`
//!
//! 三条入口，共用一个一次性码库 `~/.bolloon/rust/qr_login.json`：
//!   ① **眼镜扫电脑/手机上的二维码**：`/login` 出码（via=screen）→ 眼镜拍照 →
//!      `POST /api/auth/qr/scan`（节点侧解码）→ `POST /api/auth/qr/claim` 换令牌。
//!   ② **手机授权眼镜上显示的 6 位码**：眼镜要 `GET /api/auth/device-code`（via=device）→
//!      人在手机/电脑 `/login` 里输码点授权 → `POST /api/auth/qr/approve` → 眼镜 `claim`。
//!   ③ **已登录的眼镜带令牌回来**：`GET /api/auth/session?token=` 验签。
//!
//! 令牌 = `{code}.{ts_ms}.{ed25519 签名 hex}`，签名体 `glass|{code}|{ts}`，30 天有效。
//! 节点不存令牌：公钥就是本机 identity，离线验签即可（换机/换身份自然失效）。
//!
//! 为什么眼镜只负责拍照：眼镜上没有可用的条码解码库，也没有键盘；
//! 解码放节点（macOS Vision）与 ASR/OCR 同一手法，眼镜端零额外依赖。

use std::collections::BTreeMap;
use std::path::PathBuf;

use axum::extract::{Query, State};
use axum::response::{Html, IntoResponse};
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::server::AppState;

const TTL_MS: u64 = 180_000;
/// 令牌 30 天：镜片上不该天天重登，但也不能永久
const TOKEN_TTL_MS: u64 = 30 * 24 * 3600 * 1000;

const LOGIN_HTML: &str = include_str!("../assets/login.html");

/// 一个待兑换的登录码
#[derive(Serialize, Deserialize, Clone, Default)]
struct Pending {
    ts_ms: u64,
    /// 是否已被用掉（一次性）
    #[serde(default)]
    used: bool,
    /// 手机/电脑侧是否已授权（只对 via=device 的码有意义）
    #[serde(default)]
    approved: bool,
    /// screen = 屏幕出码给眼镜扫；device = 眼镜出码给手机授权
    #[serde(default)]
    via: String,
}

fn store_path() -> PathBuf {
    let home = std::env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("."));
    home.join(".bolloon/rust/qr_login.json")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn load() -> BTreeMap<String, Pending> {
    std::fs::read_to_string(store_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save(m: &BTreeMap<String, Pending>) {
    if let Some(dir) = store_path().parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(store_path(), serde_json::to_string_pretty(m).unwrap_or_default());
}

/// 6 位人类可读码（去掉 0/O/1/I，避免看错）
fn new_code() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let mut seed = nanos ^ ((std::process::id() as u64) << 32);
    let mut code = String::new();
    for _ in 0..6 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let i = ((seed >> 33) as usize) % ALPHABET.len();
        code.push(ALPHABET[i] as char);
    }
    code
}

/// 从任意文本里抠出码：`bolloon://login?code=ABC123` / `ABC123` / 小写都认
fn extract_code(raw: &str) -> String {
    let t = raw.trim();
    let part = t.split("code=").nth(1).unwrap_or(t);
    part.trim_matches(|c: char| !c.is_ascii_alphanumeric()).to_uppercase()
}

/// 二维码 SVG（服务端出图：手机/电脑只要能打开网页就能显示，不用前端库）
fn svg_for(text: &str) -> Option<String> {
    use qrcode::render::svg;
    let code = qrcode::QrCode::new(text.as_bytes()).ok()?;
    let svg = code
        .render::<svg::Color>()
        .min_dimensions(260, 260)
        .dark_color(svg::Color("#000000"))
        .light_color(svg::Color("#ffffff"))
        .build();
    // 去掉 XML 声明：内联进 HTML（innerHTML）时它会被当成一条注释，浏览器行为不保证
    Some(match svg.split_once("?>") {
        Some((head, rest)) if head.starts_with("<?xml") => rest.trim_start().to_string(),
        _ => svg,
    })
}

fn login_payload(code: &str) -> String {
    format!("bolloon://login?code={code}")
}

/// 造一个码并按 via 落库
fn issue(via: &str) -> String {
    let mut m = load();
    let now = now_ms();
    m.retain(|_, v| v.ts_ms + TTL_MS > now); // 顺手清过期，文件不会越长越大

    let code = new_code();
    m.insert(
        code.clone(),
        Pending { ts_ms: now, used: false, approved: false, via: via.to_string() },
    );
    save(&m);
    code
}

/// 令牌体：`{code}.{ts}.{签名 hex}`；签名覆盖 `glass|{code}|{ts}`
fn mint_token(kp: &bolloon_p2p::KeyPair, code: &str, ts: u64) -> String {
    let msg = format!("glass|{code}|{ts}");
    format!("{code}.{ts}.{}", hex::encode(kp.sign(msg.as_bytes())))
}

/// 验令牌：签名对得上 + 未过期 ⇒ 是本机身份签的
fn verify_token(kp: &bolloon_p2p::KeyPair, token: &str) -> Option<u64> {
    let mut it = token.splitn(3, '.');
    let code = it.next()?;
    let ts: u64 = it.next()?.parse().ok()?;
    let sig_hex = it.next()?;
    if code.len() != 6 {
        return None;
    }
    let sig = hex::decode(sig_hex).ok()?;
    let sig: [u8; 64] = sig.try_into().ok()?;
    let msg = format!("glass|{code}|{ts}");
    if !bolloon_p2p::KeyPair::verify(&kp.public_bytes(), msg.as_bytes(), &sig) {
        return None;
    }
    if now_ms().saturating_sub(ts) > TOKEN_TTL_MS {
        return None;
    }
    Some(ts + TOKEN_TTL_MS)
}

fn phone_of_this_node() -> Option<String> {
    std::fs::read_to_string(
        std::env::var("HOME").map(|h| format!("{h}/.bolloon/rust/phone_binding.json")).unwrap_or_default(),
    )
    .ok()
    .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
    .and_then(|v| v.get("phone").and_then(|x| x.as_str()).map(|s| s.to_string()))
}

/// GET /login —— 电脑/手机出码页面（二维码 + 输码授权）
pub async fn login_page() -> Html<&'static str> {
    Html(LOGIN_HTML)
}

/// POST /api/auth/qr/issue —— 屏幕出码（给眼镜扫）
pub async fn qr_issue(State(_st): State<AppState>) -> Json<serde_json::Value> {
    let code = issue("screen");
    let url = login_payload(&code);
    Json(serde_json::json!({
        "ok": true,
        "code": code,
        "url": url,
        "svg": svg_for(&url),
        "via": "screen",
        "expires_in_ms": TTL_MS,
    }))
}

/// GET /api/auth/qr/svg?code=xxx —— 直接把二维码当图片给（<img src>，手机/电脑都能用）
pub async fn qr_svg(
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> axum::response::Response {
    let code = extract_code(q.get("code").map(|s| s.as_str()).unwrap_or_default());
    match svg_for(&login_payload(&code)) {
        Some(svg) => (
            [(axum::http::header::CONTENT_TYPE, "image/svg+xml; charset=utf-8")],
            svg,
        )
            .into_response(),
        None => (axum::http::StatusCode::BAD_REQUEST, "bad code").into_response(),
    }
}

/// GET /api/auth/device-code —— 眼镜侧出码（屏幕上显示，等手机授权）
pub async fn device_code(State(_st): State<AppState>) -> Json<serde_json::Value> {
    let code = issue("device");
    Json(serde_json::json!({
        "ok": true,
        "code": code,
        "via": "device",
        "expires_in_ms": TTL_MS,
    }))
}

/// POST /api/auth/qr/approve {code} —— 手机/电脑授权眼镜上显示的那 6 位码
pub async fn qr_approve(Json(req): Json<serde_json::Value>) -> Json<serde_json::Value> {
    let code = extract_code(req["code"].as_str().unwrap_or_default());
    if code.is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "没有码" }));
    }
    let mut m = load();
    let Some(entry) = m.get_mut(&code) else {
        return Json(serde_json::json!({ "ok": false, "error": "码无效（眼镜上重新取一次）" }));
    };
    if entry.used {
        return Json(serde_json::json!({ "ok": false, "error": "这个码已经用过" }));
    }
    if now_ms().saturating_sub(entry.ts_ms) > TTL_MS {
        return Json(serde_json::json!({ "ok": false, "error": "码已过期，让眼镜重新出码" }));
    }
    entry.approved = true;
    let via = entry.via.clone();
    save(&m);
    Json(serde_json::json!({ "ok": true, "code": code, "via": via }))
}

/// GET /api/auth/qr/status?code=xxx —— 出码的一侧轮询"扫了/授权了没有"
pub async fn qr_status(Query(q): Query<std::collections::HashMap<String, String>>) -> Json<serde_json::Value> {
    let code = extract_code(q.get("code").map(|s| s.as_str()).unwrap_or_default());
    let m = load();
    let Some(entry) = m.get(&code) else {
        return Json(serde_json::json!({ "ok": false, "error": "未知的码" }));
    };
    Json(serde_json::json!({
        "ok": true,
        "code": code,
        "via": entry.via,
        "approved": entry.approved,
        "used": entry.used,
        "expires_in_ms": TTL_MS.saturating_sub(now_ms().saturating_sub(entry.ts_ms)),
    }))
}

#[derive(Deserialize)]
pub struct ClaimRequest {
    pub code: String,
}

/// POST /api/auth/qr/claim {code} —— 眼镜兑换会话令牌
pub async fn qr_claim(State(st): State<AppState>, Json(req): Json<ClaimRequest>) -> Json<serde_json::Value> {
    // 扫出来可能是整条 URL，也可能只有码
    let code = extract_code(&req.code);
    if code.is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "没有码" }));
    }

    let mut m = load();
    let Some(entry) = m.get(&code).cloned() else {
        return Json(serde_json::json!({ "ok": false, "error": "码无效或已被使用" }));
    };
    if entry.used {
        return Json(serde_json::json!({ "ok": false, "error": "这个码已经用过" }));
    }
    if now_ms().saturating_sub(entry.ts_ms) > TTL_MS {
        return Json(serde_json::json!({ "ok": false, "error": "二维码已过期，重新生成" }));
    }
    // 眼镜自己出的码必须有人（手机/电脑）授权过才给令牌：
    // 那串码就显示在镜片上，谁看到都能念出来，没授权等于没锁。
    if entry.via == "device" && !entry.approved {
        return Json(serde_json::json!({ "ok": false, "error": "还没在手机/电脑上授权", "need_approve": true }));
    }

    // 一次性码：兑换即废
    if let Some(v) = m.get_mut(&code) {
        v.used = true;
    }
    save(&m);

    let token = mint_token(&st.identity, &code, entry.ts_ms);
    Json(serde_json::json!({
        "ok": true,
        "did": st.identity.did.as_str(),
        "phone": phone_of_this_node(),
        "token": token,
        "code": code,
        "expires_at_ms": entry.ts_ms + TOKEN_TTL_MS,
    }))
}

#[derive(Deserialize)]
pub struct ScanRequest {
    /// 眼镜拍的 JPEG（base64，可带 data: 前缀）
    pub image_base64: String,
}

/// POST /api/auth/qr/scan {image_base64} —— 眼镜拍照，节点解二维码
pub async fn qr_scan(Json(req): Json<ScanRequest>) -> Json<serde_json::Value> {
    use base64::Engine;
    let raw = req.image_base64.split(',').last().unwrap_or(&req.image_base64).trim();
    let bytes = match base64::engine::general_purpose::STANDARD.decode(raw) {
        Ok(b) => b,
        Err(e) => return Json(serde_json::json!({ "ok": false, "error": format!("base64 解码失败: {e}") })),
    };
    if bytes.len() < 256 {
        return Json(serde_json::json!({ "ok": false, "error": "图片太小，可能没拍到" }));
    }
    match crate::vision::qr_decode(&bytes).await {
        Ok(text) => {
            let code = extract_code(&text);
            if code.is_empty() {
                Json(serde_json::json!({ "ok": false, "error": "扫到内容但不是登录码", "text": text }))
            } else {
                Json(serde_json::json!({ "ok": true, "code": code, "text": text }))
            }
        }
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

/// GET /api/auth/session?token=xxx —— 眼镜启动时确认令牌还有效
pub async fn session_check(
    State(st): State<AppState>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let token = q.get("token").cloned().unwrap_or_default();
    if token.is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "没有令牌" }));
    }
    match verify_token(&st.identity, &token) {
        Some(expires_at_ms) => Json(serde_json::json!({
            "ok": true,
            "did": st.identity.did.as_str(),
            "expires_at_ms": expires_at_ms,
        })),
        None => Json(serde_json::json!({ "ok": false, "error": "令牌无效或已过期（重新扫一次）" })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_code_handles_url_and_bare_code() {
        assert_eq!(extract_code("bolloon://login?code=ABC234"), "ABC234");
        assert_eq!(extract_code("  bolloon://login?code=abc234\n"), "ABC234");
        assert_eq!(extract_code("XYZ789"), "XYZ789");
        assert_eq!(extract_code(""), "");
    }

    #[test]
    fn svg_for_produces_qr_svg() {
        let svg = svg_for(&login_payload("ABC234")).expect("qr");
        assert!(svg.starts_with("<svg"), "内联 SVG 必须直接以 <svg 开头: {}", &svg[..40.min(svg.len())]);
        assert!(svg.contains("<path") && svg.contains("d=\"M"), "二维码必须画出模块");
        assert!(svg.contains("fill=\"#000000\""), "缺黑色模块色");
    }

    /// 令牌 = 本机身份的签名：换身份签的不收、改一个字符不收、过期不收
    #[test]
    fn token_roundtrip_and_tamper() {
        let mine = bolloon_p2p::KeyPair::generate();
        let other = bolloon_p2p::KeyPair::generate();
        let ts = now_ms();
        let token = mint_token(&mine, "ABC234", ts);
        assert!(verify_token(&mine, &token).is_some(), "自己签的应当通过");
        assert!(verify_token(&other, &token).is_none(), "别人的公钥验不过");

        // 签名覆盖 code：只改码不重签 ⇒ 失效
        let msg = format!("glass|ABC234|{ts}");
        let wrong = format!("ABC235.{ts}.{}", hex::encode(mine.sign(msg.as_bytes())));
        assert!(verify_token(&mine, &wrong).is_none(), "改码不换签名必须失效");

        let old = ts.saturating_sub(TOKEN_TTL_MS + 1_000);
        let expired = mint_token(&mine, "ABC234", old);
        assert!(verify_token(&mine, &expired).is_none(), "过期必须失效");

        assert!(verify_token(&mine, "garbage").is_none());
        assert!(verify_token(&mine, "ABC234.notanumber.00").is_none());
    }

    /// 真 HTTP 全链路：出码 → 状态 → 兑换 → 验签；一次性 / 授权门 / 设备码三条边界
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn login_flow_over_real_http() {
        let home = std::env::temp_dir().join(format!("bolloon-qr-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        unsafe { std::env::set_var("BOLLOON_HOME", &home) };
        unsafe { std::env::set_var("HOME", &home) };

        let llm = bolloon_llm::LlmRuntime::new(
            vec![bolloon_llm::ProviderConfig {
                id: "test".into(),
                base_url: "http://127.0.0.1:1/v1".into(),
                api_key: None,
                default_model: "test-model".into(),
            }],
            1,
        );
        let state = AppState::new(llm);
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = crate::server::serve_on(state, listener).await;
        });
        let base = format!("http://{addr}");

        tokio::task::spawn_blocking(move || {
            let post = |path: &str, body: serde_json::Value| -> serde_json::Value {
                ureq::post(&format!("{base}{path}"))
                    .send_json(body)
                    .unwrap()
                    .into_json()
                    .unwrap()
            };
            let get = |path: &str| -> serde_json::Value {
                ureq::get(&format!("{base}{path}")).call().unwrap().into_json().unwrap()
            };

            // ① 屏幕出码：带 SVG、状态是未用
            let issued = post("/api/auth/qr/issue", serde_json::json!({}));
            assert_eq!(issued["ok"], true, "{issued}");
            let code = issued["code"].as_str().unwrap().to_string();
            assert_eq!(code.len(), 6);
            assert!(issued["svg"].as_str().unwrap().starts_with("<svg"));
            let st = get(&format!("/api/auth/qr/status?code={code}"));
            assert_eq!(st["used"], false);
            assert_eq!(st["approved"], false);

            // ② 兑换：拿令牌，令牌能验签
            let claimed = post("/api/auth/qr/claim", serde_json::json!({ "code": code }));
            assert_eq!(claimed["ok"], true, "{claimed}");
            let token = claimed["token"].as_str().unwrap().to_string();
            let sess = get(&format!("/api/auth/session?token={token}"));
            assert_eq!(sess["ok"], true, "{sess}");

            // ③ 一次性：同一个码再兑换必须失败
            let again = post("/api/auth/qr/claim", serde_json::json!({ "code": code }));
            assert_eq!(again["ok"], false, "一次性码不能被用两次: {again}");

            // ④ 伪装令牌不收
            let forged = get(&format!("/api/auth/session?token={code}.{}.deadbeef", now_ms()));
            assert_eq!(forged["ok"], false, "假签名不许通过: {forged}");

            // ⑤ 设备码（眼镜出码）：没授权前不给令牌，手机授权后可以换
            let dev = get("/api/auth/device-code");
            assert_eq!(dev["ok"], true, "{dev}");
            assert_eq!(dev["via"], "device");
            let dcode = dev["code"].as_str().unwrap().to_string();
            let blocked = post("/api/auth/qr/claim", serde_json::json!({ "code": dcode }));
            assert_eq!(blocked["ok"], false, "眼镜自己出的码没人授权不许登录: {blocked}");
            assert_eq!(blocked["need_approve"], true, "{blocked}");
            let approved = post("/api/auth/qr/approve", serde_json::json!({ "code": dcode }));
            assert_eq!(approved["ok"], true, "{approved}");
            let st2 = get(&format!("/api/auth/qr/status?code={dcode}"));
            assert_eq!(st2["approved"], true);
            let ok = post("/api/auth/qr/claim", serde_json::json!({ "code": dcode }));
            assert_eq!(ok["ok"], true, "{ok}");

            // ⑥ 扫码兑换：扫出来的整条 URL 也要认
            let issued2 = post("/api/auth/qr/issue", serde_json::json!({}));
            let url = issued2["url"].as_str().unwrap().to_string();
            let via_url = post("/api/auth/qr/claim", serde_json::json!({ "code": url }));
            assert_eq!(via_url["ok"], true, "{via_url}");

            // ⑦ /login 页面真的能打开，且引用了出码接口
            let page = ureq::get(&format!("{base}/login")).call().unwrap().into_string().unwrap();
            assert!(page.contains("/api/auth/qr/issue"), "登录页要自己出码");
            assert!(page.contains("授权这台眼镜"), "登录页要能输入眼镜上的 6 位码授权");
        })
        .await
        .unwrap();

        let _ = std::fs::remove_dir_all(&home);
    }
}
