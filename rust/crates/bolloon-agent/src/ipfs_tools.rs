//! IPFS / IPNS 工具（Kubo HTTP API）
//!
//! 2026-10-31 (leo: 「目前的 IPFS 功能，工具没有分配给 bolloon」):
//! TS 侧早就有 `ipfs_add` / `ipfs_cat` / `ipfs_ls` / `ipns_publish`，Rust 版智能体的工具注册表里
//! 一个都没有 —— 能力存在但对智能体不可见。这里把三个读/写原语补进 Rust 内置工具，
//! 并默认授予（可逆、只碰本地节点，不涉及删改本机文件）。
//!
//! 端点：`BOLLOON_IPFS_API` 优先，缺省 `http://127.0.0.1:5001`（Kubo 默认 API）。
//! 节点没跑就**如实报错**（附安装/启动方式），不假装成功、不悄悄回退到别的东西。

use serde_json::{Value, json};

use bolloon_harness::{EffectKind, ToolDef};

fn api_base() -> String {
    std::env::var("BOLLOON_IPFS_API")
        .unwrap_or_else(|_| "http://127.0.0.1:5001".to_string())
        .trim_end_matches('/')
        .to_string()
}

/// 连不上时的统一提示（不猜端口、不谎报成功）
fn not_running(e: impl std::fmt::Display) -> String {
    format!(
        "本地 Kubo 没连上 ({e})。启动方式：`ipfs daemon`（没装就 `brew install ipfs`），\
         或用 BOLLOON_IPFS_API 指向你自己的网关。"
    )
}

pub fn ipfs_tool_defs() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "ipfs_add".into(),
            description: "把文本内容上传到本地 IPFS（Kubo），返回 CID 与大小。之后可用 ipfs_cat 读回；内容寻址，同一内容永远是同一 CID。".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "content": { "type": "string", "description": "要上传的内容（必填）" },
                    "name": { "type": "string", "description": "可选：文件名/标签（只影响 CID 之外的元信息展示）" }
                },
                "required": ["content"],
                "additionalProperties": false
            }),
            effect: EffectKind::Network,
            default_allowed: false,
        },
        ToolDef {
            name: "ipfs_cat".into(),
            description: "按 CID 从本地 IPFS（Kubo）读回内容。cid 可来自 ipfs_add 或 ipns_resolve。".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "cid": { "type": "string", "description": "IPFS CID（必填）" },
                    "max_chars": { "type": "integer", "description": "最多返回多少字符（默认 4000）" }
                },
                "required": ["cid"],
                "additionalProperties": false
            }),
            effect: EffectKind::Network,
            default_allowed: true,
        },
        ToolDef {
            name: "ipns_publish".into(),
            description: "把 IPFS CID 发布成 IPNS 名字（稳定标识：内容更新后名字不变，解析总指向最新 CID）。默认用节点自己的 self 密钥。".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "cid": { "type": "string", "description": "要发布的 IPFS CID（必填）" },
                    "key": { "type": "string", "description": "可选：用哪个 IPNS 密钥（缺省 self）" },
                    "lifetime": { "type": "string", "description": "可选：有效期，如 24h / 720h（缺省 Kubo 默认）" }
                },
                "required": ["cid"],
                "additionalProperties": false
            }),
            effect: EffectKind::Network,
            default_allowed: false,
        },
        ToolDef {
            name: "ipns_resolve".into(),
            description: "解析 IPNS 名字，拿到它当前指向的 IPFS 路径/CID。".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "IPNS 名字（如 k51… 或 /ipns/k51…，必填）" }
                },
                "required": ["name"],
                "additionalProperties": false
            }),
            effect: EffectKind::Network,
            default_allowed: true,
        },
        ToolDef {
            name: "ipfs_ls".into(),
            description: "列出 IPFS CID 下的目录条目（Kubo）。CID 指向单文件时会说明它是文件而不是目录。".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "cid": { "type": "string", "description": "IPFS CID（必填）" }
                },
                "required": ["cid"],
                "additionalProperties": false
            }),
            effect: EffectKind::Network,
            default_allowed: true,
        },
    ]
}

/// IPFS 工具执行器（阻塞 HTTP，由上层放到 blocking 线程里跑）
pub struct IpfsExecutor;

impl Default for IpfsExecutor {
    fn default() -> Self {
        Self
    }
}

impl IpfsExecutor {
    pub fn run(&self, tool: &str, args: &Value) -> Result<String, String> {
        match tool {
            "ipfs_add" => self.add(args),
            "ipfs_cat" => self.cat(args),
            "ipfs_ls" => self.ls(args),
            "ipns_publish" => self.ipns_publish(args),
            "ipns_resolve" => self.ipns_resolve(args),
            other => Err(format!("不是 IPFS 工具: {other}")),
        }
    }

    fn add(&self, args: &Value) -> Result<String, String> {
        let content = args["content"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_string();
        if content.is_empty() {
            return Err("content 必填".into());
        }
        let name = args["name"]
            .as_str()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "data.txt".to_string());
        let boundary = "----bolloonipfsboundary7MA4YWxkTrZu0gW";
        let body = format!(
            "--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{n}\"\r\n\
             Content-Type: application/octet-stream\r\n\r\n{c}\r\n--{b}--\r\n",
            b = boundary,
            n = name,
            c = content
        );
        let url = format!("{}/api/v0/add?pin=true&cid-version=1", api_base());
        let resp = ureq::post(&url)
            .set(
                "Content-Type",
                &format!("multipart/form-data; boundary={boundary}"),
            )
            .send_string(&body)
            .map_err(not_running)?;
        let v: Value = resp
            .into_json()
            .map_err(|e| format!("Kubo 返回不是 JSON: {e}"))?;
        let cid = v["Hash"].as_str().unwrap_or_default().to_string();
        if cid.is_empty() {
            return Err(format!("Kubo 没有返回 CID: {v}"));
        }
        let size = v["Size"].as_str().unwrap_or("?").to_string();
        Ok(format!(
            "✅ 已上传到 IPFS\n  CID: {cid}\n  size: {size} bytes\n  读回: ipfs_cat(cid=\"{cid}\")"
        ))
    }

    fn cat(&self, args: &Value) -> Result<String, String> {
        let cid = args["cid"].as_str().unwrap_or_default().trim().to_string();
        if cid.is_empty() {
            return Err("cid 必填".into());
        }
        let max = args["max_chars"]
            .as_u64()
            .unwrap_or(4000)
            .clamp(200, 200_000) as usize;
        let url = format!(
            "{}/api/v0/cat?arg={}",
            api_base(),
            urlencoding::encode(&cid)
        );
        let text = ureq::post(&url)
            .call()
            .map_err(not_running)?
            .into_string()
            .map_err(|e| format!("读回失败: {e}"))?;
        let n = text.chars().count();
        let shown: String = text.chars().take(max).collect();
        Ok(format!(
            "📄 {cid} ({n} 字符):\n{shown}{}",
            if n > max { "\n…(截断)" } else { "" }
        ))
    }

    fn ipns_publish(&self, args: &Value) -> Result<String, String> {
        let cid = args["cid"].as_str().unwrap_or_default().trim().to_string();
        if cid.is_empty() {
            return Err("cid 必填".into());
        }
        let mut url = format!(
            "{}/api/v0/name/publish?arg={}&allow-offline=true",
            api_base(),
            urlencoding::encode(&cid)
        );
        if let Some(k) = args["key"]
            .as_str()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            url.push_str(&format!("&key={}", urlencoding::encode(k)));
        }
        if let Some(l) = args["lifetime"]
            .as_str()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            url.push_str(&format!("&lifetime={}", urlencoding::encode(l)));
        }
        let v: Value = ureq::post(&url)
            .call()
            .map_err(not_running)?
            .into_json()
            .map_err(|e| format!("Kubo 返回不是 JSON: {e}"))?;
        let name = v["Name"].as_str().unwrap_or_default().to_string();
        if name.is_empty() {
            return Err(format!("Kubo 没有返回 IPNS 名字: {v}"));
        }
        let value = v["Value"].as_str().unwrap_or(&cid).to_string();
        Ok(format!(
            "✅ 已发布到 IPNS\n  name: {name}\n  当前指向: {value}\n  解析: ipns_resolve(name=\"{name}\")"
        ))
    }

    fn ipns_resolve(&self, args: &Value) -> Result<String, String> {
        let name = args["name"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .trim_start_matches("/ipns/")
            .to_string();
        if name.is_empty() {
            return Err("name 必填".into());
        }
        let url = format!(
            "{}/api/v0/name/resolve?arg={}",
            api_base(),
            urlencoding::encode(&name)
        );
        let v: Value = ureq::post(&url)
            .call()
            .map_err(not_running)?
            .into_json()
            .map_err(|e| format!("Kubo 返回不是 JSON: {e}"))?;
        let path = v["Path"].as_str().unwrap_or_default().to_string();
        if path.is_empty() {
            return Err(format!("解析不到: {v}"));
        }
        let cid = path.trim_start_matches("/ipfs/").to_string();
        Ok(format!(
            "🔗 {name}\n  → {path}\n  读回: ipfs_cat(cid=\"{cid}\")"
        ))
    }

    fn ls(&self, args: &Value) -> Result<String, String> {
        let cid = args["cid"].as_str().unwrap_or_default().trim().to_string();
        if cid.is_empty() {
            return Err("cid 必填".into());
        }
        let url = format!("{}/api/v0/ls?arg={}", api_base(), urlencoding::encode(&cid));
        let v: Value = ureq::post(&url)
            .call()
            .map_err(not_running)?
            .into_json()
            .map_err(|e| format!("Kubo 返回不是 JSON: {e}"))?;
        let obj = &v["Objects"][0];
        let links = obj["Links"].as_array().cloned().unwrap_or_default();
        if links.is_empty() {
            return Ok(format!("📄 {cid} 是单个文件，不是目录"));
        }
        let lines: Vec<String> = links
            .iter()
            .map(|l| {
                let name = l["Name"].as_str().unwrap_or("?");
                let size = l["Size"].as_u64().unwrap_or(0);
                let hash = l["Hash"].as_str().unwrap_or("?");
                format!("  {name}  {size} bytes  {hash}")
            })
            .collect();
        Ok(format!(
            "📂 {cid} ({} 项):\n{}",
            links.len(),
            lines.join("\n")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 参数校验必须 fail-closed（空 content / 空 cid 直接拒，不去打扰 Kubo）
    #[test]
    fn defs_and_arg_checks() {
        let defs = ipfs_tool_defs();
        let mut names: Vec<&str> = defs.iter().map(|d| d.name.as_str()).collect();
        names.sort_unstable();
        assert_eq!(
            names,
            vec![
                "ipfs_add",
                "ipfs_cat",
                "ipfs_ls",
                "ipns_publish",
                "ipns_resolve"
            ]
        );

        let ex = IpfsExecutor;
        assert!(ex.run("ipfs_add", &json!({"content": "  "})).is_err());
        assert!(ex.run("ipfs_cat", &json!({"cid": ""})).is_err());
        assert!(ex.run("ipfs_ls", &json!({"cid": ""})).is_err());
        assert!(ex.run("ipns_publish", &json!({"cid": ""})).is_err());
        assert!(ex.run("ipns_resolve", &json!({"name": " "})).is_err());
        assert!(ex.run("nope", &json!({})).is_err());
    }
}
