//! Twilio Media Streams 协议编解码（**只做形状，不做连接**）。
//!
//! 诚实边界：
//! - 这里只把 Twilio 的 WebSocket JSON 消息翻译成内部事件/帧，**没有 WebSocket 客户端**。
//! - 音频是 8kHz μ-law（base64），本模块**不做 μ-law ↔ PCM16 转换**，原样透传。
//! - 未验证实时延迟、回声消除、打断（barge-in）。
//!
//! 协议形状参考 Twilio Media Streams：入站 `connected / start / media / mark / stop`，
//! 出站 `media` 需带 `streamSid`。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum TwilioInbound {
    Connected,
    Started { stream_sid: String, call_sid: String },
    Media { payload_b64: String, track: String },
    Mark { name: String },
    Stopped,
    Unknown { event: String },
}

fn s(v: &serde_json::Value, path: &str) -> Option<String> {
    path.split('.')
        .try_fold(v, |cur, k| cur.get(k))
        .and_then(|x| x.as_str())
        .map(|x| x.to_string())
}

/// 解析一条 Twilio 入站消息。坏 JSON ⇒ 明确报错（不静默丢弃）。
pub fn parse_inbound(raw: &str) -> Result<TwilioInbound, String> {
    let v: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("Twilio 消息不是合法 JSON: {e}"))?;
    let event = s(&v, "event").unwrap_or_default();
    Ok(match event.as_str() {
        "connected" => TwilioInbound::Connected,
        "start" => TwilioInbound::Started {
            stream_sid: s(&v, "streamSid").or_else(|| s(&v, "start.streamSid")).unwrap_or_default(),
            call_sid: s(&v, "start.callSid").unwrap_or_default(),
        },
        "media" => TwilioInbound::Media {
            payload_b64: s(&v, "media.payload").unwrap_or_default(),
            track: s(&v, "media.track").unwrap_or_else(|| "inbound".into()),
        },
        "mark" => TwilioInbound::Mark {
            name: s(&v, "mark.name").unwrap_or_default(),
        },
        "stop" => TwilioInbound::Stopped,
        other => TwilioInbound::Unknown { event: other.to_string() },
    })
}

/// 生成一条出站 `media` 消息（payload 已是 base64 的 μ-law）。
pub fn encode_media(stream_sid: &str, payload_b64: &str) -> String {
    serde_json::json!({
        "event": "media",
        "streamSid": stream_sid,
        "media": { "payload": payload_b64 }
    })
    .to_string()
}

/// 生成一条 `mark`（用于确认播放到哪里）
pub fn encode_mark(stream_sid: &str, name: &str) -> String {
    serde_json::json!({
        "event": "mark",
        "streamSid": stream_sid,
        "mark": { "name": name }
    })
    .to_string()
}

/// 生成 `clear`（打断当前播放；barge-in 的关键消息，但**未验证**）
pub fn encode_clear(stream_sid: &str) -> String {
    serde_json::json!({ "event": "clear", "streamSid": stream_sid }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_connected_and_started() {
        assert_eq!(parse_inbound(r#"{"event":"connected"}"#).unwrap(), TwilioInbound::Connected);
        let raw = r#"{"event":"start","start":{"streamSid":"MZ1","callSid":"CA1"}}"#;
        assert_eq!(
            parse_inbound(raw).unwrap(),
            TwilioInbound::Started { stream_sid: "MZ1".into(), call_sid: "CA1".into() }
        );
    }

    #[test]
    fn parses_media_and_unknown() {
        let raw = r#"{"event":"media","media":{"payload":"AAAA","track":"inbound"}}"#;
        assert_eq!(
            parse_inbound(raw).unwrap(),
            TwilioInbound::Media { payload_b64: "AAAA".into(), track: "inbound".into() }
        );
        assert_eq!(
            parse_inbound(r#"{"event":"whatever"}"#).unwrap(),
            TwilioInbound::Unknown { event: "whatever".into() }
        );
    }

    #[test]
    fn bad_json_is_error_not_silent() {
        assert!(parse_inbound("not json").is_err());
    }

    #[test]
    fn outbound_roundtrip_shape() {
        let m = encode_media("MZ1", "AAAA");
        let v: serde_json::Value = serde_json::from_str(&m).unwrap();
        assert_eq!(v["event"], "media");
        assert_eq!(v["streamSid"], "MZ1");
        assert_eq!(v["media"]["payload"], "AAAA");

        let c: serde_json::Value = serde_json::from_str(&encode_clear("MZ1")).unwrap();
        assert_eq!(c["event"], "clear");
    }
}
