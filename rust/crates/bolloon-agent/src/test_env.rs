//! #[cfg(test)] 共享测试环境: `BOLLOON_AGENT_DIR` 是**进程级**环境变量。
//!
//! 2026-11-06: `domain_tools` 与 `belief_tools` 各自持有一把锁, 但两把锁互不知道 ⇒
//! 两个模块的测试仍可能同时改这个变量, 表现就是 `remember` 刚写、另一个测试把目录
//! 换掉 ⇒ "无命中记忆" 之类的随机假红。这里提供**全 crate 唯一**的一把锁 + 唯一目录。

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

pub static ENV_LOCK: Mutex<()> = Mutex::new(());
static SEQ: AtomicU64 = AtomicU64::new(0);

pub fn unique_dir(prefix: &str) -> PathBuf {
    let n = SEQ.fetch_add(1, Ordering::SeqCst);
    let d = std::env::temp_dir().join(format!(
        "bolloon_{}_{}_{}",
        prefix,
        std::process::id(),
        n
    ));
    let _ = std::fs::remove_dir_all(&d);
    let _ = std::fs::create_dir_all(&d);
    d
}

pub fn isolate(prefix: &str) -> (MutexGuard<'static, ()>, PathBuf) {
    let guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let d = unique_dir(prefix);
    unsafe { std::env::set_var("BOLLOON_AGENT_DIR", d.to_str().unwrap()) };
    (guard, d)
}
