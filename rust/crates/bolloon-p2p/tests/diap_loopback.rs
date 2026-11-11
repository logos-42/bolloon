//! DIAP 传输双节点回环（需要 `--features diap-backend`）。
//!
//! 证明的是：只交换 NodeId（不给 IP/端口），两个 iroh 端点也能建立连接并送达消息。
//! discovery/relay 由 DIAP SDK 的 iroh 1.4 presets 提供。
#![cfg(feature = "diap-backend")]

use std::time::Duration;

use bolloon_kernel::transport::TransportMessage;
use bolloon_p2p::diap_transport::DiapTransport;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn diap_two_nodes_exchange_message_by_node_id_only() {
    let a = DiapTransport::new("did:pi:a").await.expect("A 端点起不来");
    let b = DiapTransport::new("did:pi:b").await.expect("B 端点起不来");
    assert_ne!(a.node_id(), b.node_id(), "两个节点必须不同 id");

    a.spawn_listener();
    b.spawn_listener();
    // 给 discovery/relay 注册留时间；不伪造「立刻可达」
    tokio::time::sleep(Duration::from_secs(3)).await;

    let payload = serde_json::json!({ "hello": "diap", "n": 1 });
    // 交换完整地址（含 IP），不依赖 n0 relay/discovery —— 只给 NodeId 在 relay 不可达时
    // 会报 "No addressing information available"。
    // 只保留真实局域网 IP，过滤代理 fake-ip (198.18.0.0/15, 不可路由)
    let mut addrb = b.address_json();
    if let Some(arr) = addrb["addrs"].as_array() {
        let keep: Vec<serde_json::Value> = arr.iter()
            .filter(|v| v["Ip"].as_str().map(|s| !s.starts_with("198.18.")).unwrap_or(true))
            .cloned().collect();
        if !keep.is_empty() { addrb["addrs"] = serde_json::json!(keep); }
    }
    a.send_to_addr(
        addrb,
        TransportMessage {
            to: Some(b.node_id()),
            topic: Some("loopback".into()),
            payload: payload.clone(),
            from: Some("did:pi:a".into()),
        },
    )
    .await
    .expect("按完整地址发送应成功");

    let got = tokio::time::timeout(Duration::from_secs(25), b.recv())
        .await
        .expect("25s 内应收到消息（超时 = discovery/relay 不可达）")
        .expect("channel 不应关闭");
    assert_eq!(got.from_did, "did:pi:a");
    let v: serde_json::Value = serde_json::from_str(&got.content).expect("payload 应是 JSON");
    assert_eq!(v["hello"], "diap");
    assert_eq!(v["n"], 1);
}
