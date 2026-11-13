//! 多设备自动同步（2026-11-13）。
//!
//! 手动 `export/import` 已经能用，但每台设备都要人点一次不现实。这里把它做成后台任务：
//! - `POST /api/devices/register {url, diap?}` 把另一台设备登记进「同步组」；
//! - 后台每 `BOLLOON_DEVICE_SYNC_SECS`（默认 30s）遍历组内设备，
//!   `GET {peer}/api/cross-chat/export?since_ms=<水位>` → `import_turns`（幂等）→ 推进水位；
//! - 同步时顺带拉对方 `/api/devices`，把同组的其它设备自动并进来（设备自己扩散）；
//! - 全关：`BOLLOON_DEVICE_SYNC=0`；组名：`BOLLOON_DEVICE_GROUP`（默认=本机 DID，
//!   同一用户的多台设备设成同一个值即可自动成组）。
//!
//! 诚实边界：同步只搬运**会话记录**（谁在什么时候说了什么/下了什么指令），
//! 不搬运身份私钥、不搬运对方未授权的权限；传输走 `peer_json`（有 DIAP 就走隧道）。

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use axum::extract::State;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex as AsyncMutex;

use crate::cross_chat::{self, Turn};
use crate::server::AppState;

static LOCK: Mutex<()> = Mutex::new(());
const STATE_FILE: &str = "device-sync.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Device {
    pub url: String,
    #[serde(default)]
    pub did: String,
    /// 已同步到的时间水位（下轮从这之后拉）
    #[serde(default)]
    pub last_sync_ms: u64,
    #[serde(default)]
    pub last_ok_ms: u64,
    #[serde(default)]
    pub last_error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncState {
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub devices: Vec<Device>,
    #[serde(default)]
    pub last_run_ms: u64,
    #[serde(default)]
    pub last_added: usize,
    #[serde(default)]
    pub last_error: String,
}

fn state_path() -> PathBuf {
    crate::server::data_dir().join(STATE_FILE)
}

fn now_ms() -> u64 {
    chrono::Utc::now().timestamp_millis() as u64
}

fn group_of(st: &AppState) -> String {
    std::env::var("BOLLOON_DEVICE_GROUP")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| st.identity.did.as_str().to_string())
}

pub fn load() -> SyncState {
    let mut s: SyncState = std::fs::read_to_string(state_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(SyncState {
            group: String::new(),
            devices: Vec::new(),
            last_run_ms: 0,
            last_added: 0,
            last_error: String::new(),
        });
    if s.group.is_empty() {
        s.group = String::new(); // 由调用方填本机 DID
    }
    s
}

fn save(s: &SyncState) {
    if let Ok(t) = serde_json::to_string_pretty(s) {
        let _ = std::fs::write(state_path(), t);
    }
}

/// 登记一台设备（幂等：同 URL 只更新 DID/地址）。
pub fn register(st: &AppState, url: &str, did: &str) -> SyncState {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut s = load();
    if s.group.is_empty() {
        s.group = group_of(st);
    }
    let u = url.trim().trim_end_matches('/').to_string();
    if !u.is_empty() {
        match s.devices.iter_mut().find(|d| d.url == u) {
            Some(d) => {
                if !did.is_empty() {
                    d.did = did.to_string();
                }
            }
            None => s.devices.push(Device {
                url: u,
                did: did.to_string(),
                last_sync_ms: 0,
                last_ok_ms: 0,
                last_error: String::new(),
            }),
        }
    }
    save(&s);
    s
}

/// 立即同步一轮：拉增量 → 幂等合并 → 推进水位 → 顺带扩散设备列表。
pub async fn sync_once(st: &AppState) -> Value {
    let group = group_of(st);
    let mut state = {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut s = load();
        if s.group.is_empty() {
            s.group = group.clone();
        }
        s
    };

    let mut total_added = 0usize;
    let mut reports: Vec<Value> = Vec::new();

    // 先给本轮遍历做个快照，避免同步过程中 push 新设备导致无限循环
    let snapshot: Vec<Device> = state.devices.clone();
    for dev in snapshot {
        let base = dev.url.trim_end_matches('/').to_string();
        let since = dev.last_sync_ms;
        let export_url = format!("{base}/api/cross-chat/export?since_ms={since}");
        let mut added = 0usize;
        let mut newest = since;
        let mut err = String::new();

        match crate::native::peer_json("GET", export_url, None).await {
            Ok(v) => {
                let turns: Vec<Turn> = v["turns"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| serde_json::from_value::<Turn>(x.clone()).ok())
                            .collect()
                    })
                    .unwrap_or_default();
                if let Some(max_ts) = turns.iter().map(|t| t.ts_ms).max() {
                    newest = newest.max(max_ts.saturating_add(1));
                }
                let (a, _skipped) = cross_chat::import_turns(&crate::server::data_dir(), &turns);
                added = a;
                total_added += a;
            }
            Err(e) => err = e,
        }

        // 顺带问对方还有哪些同组设备（设备自己扩散，不需要中心）
        if err.is_empty() {
            if let Ok(list) = crate::native::peer_json("GET", format!("{base}/api/devices"), None).await {
                let mut s = load();
                for d in list["devices"].as_array().cloned().unwrap_or_default() {
                    let u = d["url"].as_str().unwrap_or_default().trim().trim_end_matches('/').to_string();
                    if u.is_empty() || u == base || u == st.identity.did.as_str() {
                        continue;
                    }
                    if !s.devices.iter().any(|x| x.url == u) {
                        s.devices.push(Device {
                            url: u,
                            did: d["did"].as_str().unwrap_or_default().to_string(),
                            last_sync_ms: 0,
                            last_ok_ms: 0,
                            last_error: String::new(),
                        });
                    }
                }
                save(&s);
            }
        }

        {
            let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let mut s = load();
            if let Some(d) = s.devices.iter_mut().find(|x| x.url == base) {
                if err.is_empty() {
                    d.last_sync_ms = newest.max(now_ms().saturating_sub(86_400_000));
                    d.last_ok_ms = now_ms();
                    d.last_error.clear();
                } else {
                    d.last_error = err.clone();
                }
            }
            save(&s);
        }
        reports.push(serde_json::json!({
            "url": base, "added": added, "ok": err.is_empty(), "error": err,
        }));
    }

    {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut s = load();
        s.last_run_ms = now_ms();
        s.last_added = total_added;
        s.last_error = reports
            .iter()
            .filter(|r| r["ok"] == serde_json::json!(false))
            .filter_map(|r| r["error"].as_str().map(str::to_string))
            .next()
            .unwrap_or_default();
        save(&s);
    }

    serde_json::json!({
        "ok": true,
        "group": group,
        "added": total_added,
        "devices": reports,
    })
}

/// 后台循环：启动 3 秒后跑一轮，之后每 N 秒一轮。`BOLLOON_DEVICE_SYNC=0` 关闭。
pub fn spawn(st: AppState) {
    if std::env::var("BOLLOON_DEVICE_SYNC")
        .map(|v| v.trim() == "0")
        .unwrap_or(false)
    {
        return;
    }
    let secs = std::env::var("BOLLOON_DEVICE_SYNC_SECS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(30)
        .clamp(2, 3600);
    // 用异步锁防止两轮重叠（sync_once 内部也有文件锁，但这里更省）
    let gate = std::sync::Arc::new(AsyncMutex::new(()));
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(3)).await;
        loop {
            {
                let _g = gate.lock().await;
                let r = sync_once(&st).await;
                let n = r["added"].as_u64().unwrap_or(0);
                if n > 0 {
                    tracing::info!(added = n, "多设备自动同步完成");
                }
            }
            tokio::time::sleep(Duration::from_secs(secs)).await;
        }
    });
}

// ───────────── HTTP 面 ─────────────

/// POST /api/devices/register {url, did?, diap?}
pub async fn http_register(
    State(st): State<AppState>,
    axum::Json(req): axum::Json<Value>,
) -> axum::Json<Value> {
    let url = req["url"].as_str().unwrap_or_default().trim().to_string();
    if url.is_empty() {
        return axum::Json(serde_json::json!({ "ok": false, "error": "缺 url (对方设备基址)" }));
    }
    #[cfg(feature = "diap-backend")]
    if !req["diap"].is_null() {
        if let Some(hub) = crate::diap_hub::global() {
            hub.register(&url, req["diap"].clone()).await;
        }
    }
    let s = register(&st, &url, req["did"].as_str().unwrap_or_default());
    axum::Json(serde_json::json!({
        "ok": true, "group": s.group, "count": s.devices.len(),
    }))
}

/// GET /api/devices
pub async fn http_list(State(st): State<AppState>) -> axum::Json<Value> {
    let s = load();
    axum::Json(serde_json::json!({
        "ok": true,
        "group": if s.group.is_empty() { group_of(&st) } else { s.group },
        "enabled": !std::env::var("BOLLOON_DEVICE_SYNC").map(|v| v.trim() == "0").unwrap_or(false),
        "devices": s.devices,
        "last_run_ms": s.last_run_ms,
        "last_added": s.last_added,
        "last_error": s.last_error,
    }))
}

/// POST /api/devices/sync —— 立即同步一轮（不等后台定时）
pub async fn http_sync(State(st): State<AppState>) -> axum::Json<Value> {
    axum::Json(sync_once(&st).await)
}
