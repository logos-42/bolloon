//! Bolloon Poll — 轮询工具
//!
//! 提供基于指数退避的轮询功能，使用固定睡眠间隔序列：2, 4, 8, 10, 20, 100, 120 秒。

use std::time::Duration;
use tokio::time::sleep;

/// 睡眠间隔序列（秒）：2, 4, 8, 10, 20, 100, 120
pub const POLL_INTERVALS: [u64; 7] = [2, 4, 8, 10, 20, 100, 120];

/// 轮询配置
#[derive(Clone, Debug)]
pub struct PollConfig {
    pub max_retries: Option<u32>,
    pub verbose: bool,
    pub jitter: bool,
    pub once: bool,
}

impl Default for PollConfig {
    fn default() -> Self {
        Self {
            max_retries: None,
            verbose: false,
            jitter: false,
            once: false,
        }
    }
}

impl PollConfig {
    pub fn max_retries(mut self, n: u32) -> Self {
        self.max_retries = Some(n);
        self
    }
    pub fn infinite_retries(mut self) -> Self {
        self.max_retries = None;
        self
    }
    pub fn verbose(mut self, v: bool) -> Self {
        self.verbose = v;
        self
    }
    pub fn jitter(mut self, j: bool) -> Self {
        self.jitter = j;
        self
    }
    pub fn once(mut self, o: bool) -> Self {
        self.once = o;
        self
    }
}

/// 轮询结果
#[derive(Debug, Clone, PartialEq)]
pub enum PollResult {
    Success,
    MaxRetriesExceeded,
    Interrupted,
}

/// 执行轮询
pub async fn poll<F, Fut>(mut f: F, config: PollConfig) -> PollResult
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    let mut attempt = 1u32;
    let mut interval_index = 0usize;
    let interval_count = POLL_INTERVALS.len();
    let max_attempts = config.max_retries;

    if config.once {
        if config.verbose { println!("--- Attempt #{} ---", attempt); }
        match f().await {
            Ok(()) => { if config.verbose { println!("✅ Command succeeded!"); } return PollResult::Success; }
            Err(e) => { if config.verbose { println!("❌ Command failed: {}", e); } return PollResult::MaxRetriesExceeded; }
        }
    }

    loop {
        if config.verbose { println!("--- Attempt #{} ---", attempt); }

        match f().await {
            Ok(()) => { if config.verbose { println!("✅ Command succeeded!"); } return PollResult::Success; }
            Err(e) => { if config.verbose { println!("❌ Command failed: {}", e); } }
        }

        if let Some(max) = max_attempts {
            if attempt >= max {
                if config.verbose { println!("❌ Max retries ({}) reached. Giving up.", max); }
                return PollResult::MaxRetriesExceeded;
            }
        }

        if interval_index >= interval_count {
            interval_index = 0;
        }

        let raw_sleep = POLL_INTERVALS[interval_index];
        let sleep_ms = if config.jitter {
            let min = raw_sleep * 3 / 4;
            let max = raw_sleep * 5 / 4;
            let range = max - min + 1;
            let jitter = min + (attempt as u64 * 7919) % range;
            jitter
        } else {
            raw_sleep
        };

        if config.verbose { println!("Waiting {}s before next attempt...", sleep_ms); }

        sleep(Duration::from_secs(sleep_ms)).await;

        interval_index += 1;
        attempt += 1;
    }
}


/// 等到某个 TCP 端口**真的可连** (用同一套退避序列 2/4/8/10/20/100/120 秒)。
/// 用途: 「服务起来了再往下走」——CLI 启动 web、App 建窗口前、以及跨机对端探活。
pub async fn wait_tcp(addr: &str, config: PollConfig) -> PollResult {
    let target = addr.to_string();
    poll(
        move || {
            let t = target.clone();
            async move {
                match tokio::net::TcpStream::connect(&t).await {
                    Ok(_) => Ok(()),
                    Err(e) => Err(format!("连不上 {t}: {e}")),
                }
            }
        },
        config,
    )
    .await
}

/// 同步版 wait_tcp (给没有 async 上下文的调用点用, 例如 Tauri 的 setup 主线程)。
/// 退避序列与异步版一致, 保证「一套节奏」。
pub fn wait_tcp_blocking(addr: &str, config: PollConfig) -> PollResult {
    let mut attempt = 1u32;
    let mut idx = 0usize;
    loop {
        if std::net::TcpStream::connect(addr).is_ok() {
            return PollResult::Success;
        }
        if let Some(max) = config.max_retries {
            if attempt >= max {
                return PollResult::MaxRetriesExceeded;
            }
        }
        let secs = POLL_INTERVALS[idx % POLL_INTERVALS.len()];
        std::thread::sleep(Duration::from_secs(secs));
        idx += 1;
        attempt += 1;
    }
}

/// 等到某个 HTTP 端点返回 2xx (阻塞客户端 ureq 放在 spawn_blocking, 不占 runtime)。
/// `url` 形如 `http://127.0.0.1:54188/api/health`。
pub async fn wait_http(url: &str, config: PollConfig) -> PollResult {
    let target = url.to_string();
    poll(
        move || {
            let t = target.clone();
            async move {
                let probe = t.clone();
                let ok = tokio::task::spawn_blocking(move || {
                    ureq::get(&probe)
                        .timeout(std::time::Duration::from_secs(3))
                        .call()
                        .map(|r| r.status() < 400)
                        .unwrap_or(false)
                })
                .await
                .unwrap_or(false);
                if ok { Ok(()) } else { Err(format!("{t} 还没就绪")) }
            }
        },
        config,
    )
    .await
}

/// 便捷函数：使用默认配置执行轮询
pub async fn poll_simple<F, Fut>(f: F) -> PollResult
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    poll(f, PollConfig::default()).await
}

/// 便捷函数：带最大重试次数的轮询
pub async fn poll_with_retries<F, Fut>(f: F, max_retries: u32) -> PollResult
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    poll(f, PollConfig::default().max_retries(max_retries)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_poll_success_first_try() {
        let mut call_count = 0;
        let result = poll(
            || { call_count += 1; async move { Ok(()) } },
            PollConfig::default().verbose(false),
        ).await;
        assert_eq!(result, PollResult::Success);
        assert_eq!(call_count, 1);
    }

    #[tokio::test]
    async fn test_poll_max_retries() {
        let result = poll(
            || async { Err("always fails".to_string()) },
            PollConfig::default().max_retries(2).verbose(false),
        ).await;
        assert_eq!(result, PollResult::MaxRetriesExceeded);
    }

    #[tokio::test]
    async fn test_poll_intervals() {
        assert_eq!(POLL_INTERVALS, [2, 4, 8, 10, 20, 100, 120]);
        assert_eq!(POLL_INTERVALS.len(), 7);
    }

    #[tokio::test]
    async fn wait_tcp_succeeds_on_listening_port() {
        // 起一个真监听: 127.0.0.1:0 由内核分配, 再 poll 它 —— 必须第一次就 Success
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        tokio::spawn(async move { loop { if listener.accept().await.is_err() { break } } });
        let r = wait_tcp(&addr, PollConfig::default().max_retries(2)).await;
        assert_eq!(r, PollResult::Success);
    }

    #[tokio::test]
    async fn wait_tcp_gives_up_after_max_retries() {
        // 127.0.0.1:1 基本不会有人监听; max_retries(1) ⇒ 一次失败就放弃, 不空转
        let r = wait_tcp("127.0.0.1:1", PollConfig::default().max_retries(1)).await;
        assert_eq!(r, PollResult::MaxRetriesExceeded);
    }

    #[tokio::test]
    async fn test_poll_once() {
        let result = poll(
            || async { Err("fails".to_string()) },
            PollConfig::default().once(true).verbose(false),
        ).await;
        assert_eq!(result, PollResult::MaxRetriesExceeded);
    }
}
