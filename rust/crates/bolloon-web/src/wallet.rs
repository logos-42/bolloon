//! 眼镜端「钱包」视图数据 — GET /api/wallet
//!
//! 眼镜上要能一眼看到：这是哪个地址、还剩多少钱、有没有等我点头的支付/授权。
//! 数字必须是真的：余额走链上 RPC（eth_getBalance / USDC balanceOf），
//! 拿不到就明确报错，绝不显示编造的数字。
//!
//! 环境变量（都可省）：
//! - BOLLOON_WALLET_FILE  钱包文件（默认按 ~/.hermes/wallets/{sepolia-test,mainnet}.json 顺序找）
//! - BOLLOON_RPC_URL      覆盖 RPC 端点
//!
//! 私钥从不出这个模块、不写日志、不进返回体。

use std::path::PathBuf;

use axum::Json;

const USDC_BASE: &str = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_SEPOLIA: &str = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const RPC_BASE: &str = "https://mainnet.base.org";
const RPC_SEPOLIA: &str = "https://ethereum-sepolia-rpc.publicnode.com";

fn home() -> PathBuf {
    std::env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("."))
}

fn wallet_file() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("BOLLOON_WALLET_FILE") {
        let p = PathBuf::from(p);
        return p.exists().then_some(p);
    }
    ["sepolia-test.json", "mainnet.json"]
        .iter()
        .map(|n| home().join(".hermes/wallets").join(n))
        .find(|p| p.exists())
}

fn hex_to_f64(hex: &str, decimals: u32) -> Option<f64> {
    let h = hex.trim_start_matches("0x");
    if h.is_empty() || h == "0" {
        return Some(0.0);
    }
    // u128 够 ETH/USDC 用；超了按 u128 上限处理（不会发生在这两个币上）
    let v = u128::from_str_radix(h, 16).ok()?;
    Some(v as f64 / 10f64.powi(decimals as i32))
}

fn rpc_call(url: &str, method: &str, params: serde_json::Value) -> Result<String, String> {
    let body = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": method, "params": params
    })
    .to_string();
    let resp = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(6))
        .build()
        .post(url)
        .set("Content-Type", "application/json")
        .send_string(&body)
        .map_err(|e| format!("{method}: {e}"))?;
    let text = resp.into_string().map_err(|e| format!("{method}: {e}"))?;
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("{method}: 非 JSON 响应 {e}"))?;
    if let Some(err) = v.get("error") {
        return Err(format!("{method}: RPC 报错 {err}"));
    }
    v.get("result")
        .and_then(|r| r.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("{method}: 响应缺 result"))
}

/// USDC balanceOf 的 calldata: 0x70a08231 + 地址左补零到 32 字节
fn balance_of_calldata(address: &str) -> String {
    let a = address.trim_start_matches("0x").to_lowercase();
    format!("0x70a08231{:0>64}", a)
}

/// GET /api/wallet → { ok, address, network, eth, usdc, currency, ... }
pub async fn wallet() -> Json<serde_json::Value> {
    let Some(path) = wallet_file() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "没有钱包文件",
            "hint": "设置 BOLLOON_WALLET_FILE，或把钱包放到 ~/.hermes/wallets/sepolia-test.json"
        }));
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            return Json(serde_json::json!({
                "ok": false, "error": format!("读钱包失败: {e}")
            }))
        }
    };
    let json: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => return Json(serde_json::json!({ "ok": false, "error": format!("钱包 JSON 解析失败: {e}") })),
    };
    let address = json
        .get("address")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    if address.is_empty() {
        return Json(serde_json::json!({
            "ok": false,
            "error": "钱包文件里没有 address 字段",
            "hint": "用 `cast wallet address --private-key …` 推出地址后写进钱包文件（不要提交私钥）"
        }));
    }
    let network = json
        .get("network")
        .and_then(|v| v.as_str())
        .unwrap_or("sepolia")
        .to_string();
    let is_base = network.contains("base") || network.contains("mainnet.eth") || network == "ethereum-mainnet";

    let rpc = std::env::var("BOLLOON_RPC_URL").unwrap_or_else(|_| {
        // 注意：ethereum-mainnet 的钱包默认查 Base（bolloon 的支付链是 Base + USDC）
        if is_base { RPC_BASE.to_string() } else { RPC_SEPOLIA.to_string() }
    });
    let usdc = if is_base { USDC_BASE } else { USDC_SEPOLIA };
    let chain_label = if is_base { "base" } else { "sepolia" };

    let addr = address.clone();
    let rpc_c = rpc.clone();
    let usdc_c = usdc.to_string();
    let result = tokio::task::spawn_blocking(move || {
        let eth_hex = rpc_call(&rpc_c, "eth_getBalance", serde_json::json!([addr, "latest"]))?;
        let usdc_hex = rpc_call(
            &rpc_c,
            "eth_call",
            serde_json::json!([{ "to": usdc_c, "data": balance_of_calldata(&addr) }, "latest"]),
        )?;
        Ok::<(String, String), String>((eth_hex, usdc_hex))
    })
    .await;

    match result {
        Ok(Ok((eth_hex, usdc_hex))) => Json(serde_json::json!({
            "ok": true,
            "address": address,
            "network": chain_label,
            "rpc": rpc,
            "eth": hex_to_f64(&eth_hex, 18),
            "usdc": hex_to_f64(&usdc_hex, 6),
            "usdc_contract": usdc,
            "source": "chain",
        })),
        Ok(Err(e)) => Json(serde_json::json!({
            "ok": false, "address": address, "network": chain_label, "error": e
        })),
        Err(e) => Json(serde_json::json!({
            "ok": false, "address": address, "network": chain_label,
            "error": format!("RPC 任务失败: {e}")
        })),
    }
}
