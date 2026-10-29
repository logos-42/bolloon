//! 多节点协调: 「单机原子切换」之上的**最轻量**一层 —— 租约 + 栅栏令牌。
//!
//! 必须先说清楚边界 (不说清楚就是骗人):
//!
//! - `ConfigManager::apply` 提供的是**单机原子切换**: 本进程内读者不会看到半个配置,
//!   版本号单调。它**不**提供跨进程/跨节点的全局一致性。
//! - 本模块提供 `LeaseFenced`: 同一命名空间内同一时刻只有一个写入者, 栅栏令牌 (fencing
//!   token) 单调递增, 过期写入者拿旧令牌会被识别并放弃。它**不是**分布式事务, 也**不是**
//!   共识协议 (没有 Paxos/Raft):
//!     * 跨节点可见性靠**对端拉取** (`sync_from_peer`), 属于最终一致 + 后写覆盖;
//!     * 协调介质是本地/共享文件系统 (同机多进程、或挂了共享盘的容器);
//!     * A 类安全控制 (紧急停止/撤销) **不跨节点协调** —— 每个节点必须各自置位,
//!       这是刻意的: 安全刹车不能依赖网络。
//! - 真正需要"全局事务"的场景 (跨节点配置与业务状态一起提交) 不在本模块承诺范围,
//!   那需要参与者日志/两阶段提交, 本仓库没有, 也不打算用配置系统偷偷实现一个。
//!
//! 因此: 单节点部署 → 用 `apply`; 同机多进程 / 共享盘多实例 → 用 `apply_coordinated`;
//! 多机 → 各节点本地 `apply_coordinated` + 定期 `sync_from_peer`, 并接受有界延迟。

use serde::{Deserialize, Serialize};
use std::fs::{create_dir_all, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum CoordError {
    #[error("租约被 {holder} 持有 (fencing={fencing}), 到期于 {expires_at_ms}ms, 现在 {now_ms}ms")]
    LeaseHeld {
        holder: String,
        fencing: u64,
        expires_at_ms: u64,
        now_ms: u64,
    },
    #[error("租约不匹配: 期望 {expected_holder}#{expected_fencing}, 实际 {actual_holder}#{actual_fencing}")]
    LeaseMismatch {
        expected_holder: String,
        expected_fencing: u64,
        actual_holder: String,
        actual_fencing: u64,
    },
    #[error("栅栏令牌过期: 本地 {mine}, 当前 {current} —— 该写入必须放弃 (防止脑裂覆盖)")]
    FencedOut { mine: u64, current: u64 },
    #[error("协调器 I/O 失败: {0}")]
    Io(String),
    #[error("协调模式要求显式 based_on 版本 (禁止无版本提交, 会静默覆盖他人更新)")]
    MissingBasedOn,
}

/// 一份租约。`fencing` 单调递增: 数字更小的持有者一律视为过期。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Lease {
    pub key: String,
    pub holder: String,
    pub fencing: u64,
    pub acquired_at_ms: u64,
    pub expires_at_ms: u64,
}

/// 协调端口 (可替换: 文件、etcd、Redis、自研; 本仓库只提供文件实现, 不引新依赖)。
pub trait LeaseCoordinator: Send + Sync {
    fn acquire(&self, holder: &str, ttl_ms: u64) -> Result<Lease, CoordError>;
    fn renew(&self, lease: &Lease, ttl_ms: u64) -> Result<Lease, CoordError>;
    fn release(&self, lease: &Lease) -> Result<(), CoordError>;
    fn peek(&self) -> Option<Lease>;
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 基于文件的租约 (同机多进程 / 共享盘多实例)。
///
/// 竞态处理: 拿不到 `create_new` 就重读; 过期才抢占。抢占后**回读校验**自己是不是
/// 最终持有者 (两个节点同时抢占时, rename 的最后写者赢, 输的一方回读会发现 holder 不是自己,
/// 于是返回 LeaseHeld 而不是自欺欺人地认为拿到了租约)。
pub struct FileLeaseCoordinator {
    path: PathBuf,
    key: String,
}

impl FileLeaseCoordinator {
    pub fn new(dir: impl AsRef<Path>, key: &str) -> Self {
        Self {
            path: dir.as_ref().join(format!("{key}.lease")),
            key: key.to_string(),
        }
    }

    fn read(&self) -> Option<Lease> {
        let mut s = String::new();
        OpenOptions::new()
            .read(true)
            .open(&self.path)
            .ok()?
            .read_to_string(&mut s)
            .ok()?;
        serde_json::from_str(&s).ok()
    }

    fn write(&self, lease: &Lease) -> Result<(), CoordError> {
        if let Some(dir) = self.path.parent() {
            let _ = create_dir_all(dir);
        }
        let tmp = self.path.with_extension(format!("{}.tmp", std::process::id()));
        let body = serde_json::to_string(lease).map_err(|e| CoordError::Io(e.to_string()))?;
        {
            let mut f = OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&tmp)
                .map_err(|e| CoordError::Io(e.to_string()))?;
            f.write_all(body.as_bytes())
                .map_err(|e| CoordError::Io(e.to_string()))?;
        }
        std::fs::rename(&tmp, &self.path).map_err(|e| CoordError::Io(e.to_string()))
    }
}

impl LeaseCoordinator for FileLeaseCoordinator {
    fn acquire(&self, holder: &str, ttl_ms: u64) -> Result<Lease, CoordError> {
        let now = now_ms();
        // 1) 没人在持: create_new 抢一个空文件
        match OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&self.path)
        {
            Ok(mut f) => {
                let lease = Lease {
                    key: self.key.clone(),
                    holder: holder.to_string(),
                    fencing: 1,
                    acquired_at_ms: now,
                    expires_at_ms: now + ttl_ms,
                };
                let body =
                    serde_json::to_string(&lease).map_err(|e| CoordError::Io(e.to_string()))?;
                f.write_all(body.as_bytes())
                    .map_err(|e| CoordError::Io(e.to_string()))?;
                return Ok(lease);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(CoordError::Io(e.to_string())),
        }
        // 2) 有人在持: 未过期 → 拒绝; 已过期 → 抢 (fencing + 1)
        let cur = self.read().ok_or_else(|| {
            CoordError::Io("租约文件存在但内容不可解析 (视为不安全状态)".into())
        })?;
        if cur.expires_at_ms > now {
            return Err(CoordError::LeaseHeld {
                holder: cur.holder,
                fencing: cur.fencing,
                expires_at_ms: cur.expires_at_ms,
                now_ms: now,
            });
        }
        let lease = Lease {
            key: self.key.clone(),
            holder: holder.to_string(),
            fencing: cur.fencing + 1,
            acquired_at_ms: now,
            expires_at_ms: now + ttl_ms,
        };
        self.write(&lease)?;
        // 3) 回读校验: 输了就老实认输
        match self.read() {
            Some(seen) if seen.holder == lease.holder && seen.fencing == lease.fencing => Ok(lease),
            Some(seen) => Err(CoordError::LeaseHeld {
                holder: seen.holder,
                fencing: seen.fencing,
                expires_at_ms: seen.expires_at_ms,
                now_ms: now_ms(),
            }),
            None => Err(CoordError::Io("抢占后回读失败".into())),
        }
    }

    fn renew(&self, lease: &Lease, ttl_ms: u64) -> Result<Lease, CoordError> {
        let cur = self
            .read()
            .ok_or_else(|| CoordError::LeaseMismatch {
                expected_holder: lease.holder.clone(),
                expected_fencing: lease.fencing,
                actual_holder: "<none>".into(),
                actual_fencing: 0,
            })?;
        if cur.holder != lease.holder || cur.fencing != lease.fencing {
            return Err(CoordError::LeaseMismatch {
                expected_holder: lease.holder.clone(),
                expected_fencing: lease.fencing,
                actual_holder: cur.holder,
                actual_fencing: cur.fencing,
            });
        }
        let now = now_ms();
        let renewed = Lease {
            expires_at_ms: now + ttl_ms,
            ..lease.clone()
        };
        self.write(&renewed)?;
        Ok(renewed)
    }

    fn release(&self, lease: &Lease) -> Result<(), CoordError> {
        // 只删**自己的**租约: 若已被别人以更高 fencing 抢占, 删掉会把别人的锁删了
        if let Some(cur) = self.read() {
            if cur.fencing > lease.fencing {
                return Err(CoordError::FencedOut {
                    mine: lease.fencing,
                    current: cur.fencing,
                });
            }
            if cur.holder != lease.holder || cur.fencing != lease.fencing {
                return Err(CoordError::LeaseMismatch {
                    expected_holder: lease.holder.clone(),
                    expected_fencing: lease.fencing,
                    actual_holder: cur.holder,
                    actual_fencing: cur.fencing,
                });
            }
        }
        let _ = std::fs::remove_file(&self.path);
        Ok(())
    }

    fn peek(&self) -> Option<Lease> {
        self.read()
    }
}
