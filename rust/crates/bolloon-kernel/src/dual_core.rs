//! 双核 (Dual-Core) Kernel — 对等互维互保 + 间隔相位心跳。
//!
//! 设计 (对齐 leo 2026-10-27 双核意图: 双肺/双肾, 互相维护与保护, 细节可分工):
//! - 两个**对等** kernel 实例 (`CoreId::A` / `CoreId::B`), 任一都能承担全部职责 (可代偿)。
//! - **间隔相位** (`BeatSchedule`, phase = interval/2): 核心 A 在 t=0,Δ,2Δ... 跳, 核心 B 在
//!   t=Δ/2, 3Δ/2... 跳。双方互插, 每个核在自己两次心跳之间都恰好看到对方一次新鲜心跳 ——
//!   同时感知"对方节奏"和"自己节奏" (错相位才能互相观测而不被同拍淹没)。
//! - 互维护 (Maintenance): 双向心跳 + 对端状态可观测 + 租约续期 + 孤儿接管 (复用宿主注入)。
//! - 互保护 (Protection): 防双主 (fencing token) + 防误接管 (stale 双维 + 二次确认窗口)
//!   + 过载不接管 (P3, 避免双核一起雪崩) + 证据保护 (接管必走恢复动作写事实)。
//! - 纯机制: 心跳/租约/栅栏/校验判定零 I/O; 读写心跳与恢复动作由端口注入 (守 K1)。
//!
//! 与架构原则的对齐: 双核分工的是"维护面", 执行权永远靠 lease + fencing 唯一,
//! 不产生第二条执行路径; HA 自身只允许新增心跳/租约/fencing 三类状态, 不新增任何业务状态。
//!
//! 接线 (跨进程): `spawn_kernel_ha_from_env` 读 `BOLLOON_HA` (1 / both / off) 与
//! `BOLLOON_KERNEL_CORE` (A|B), 用 `FileHeartbeatStore` 把心跳落到 `~/.bolloon/kernel-ha/<core>.heartbeat.json`
//! (对齐 TS 侧 `~/.bolloon/kernel-ha/*.heartbeat`), 让两个独立进程互相探测。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

use crate::ha::RecoveryAction;

/// 核心标识 (对等, 非主备)。`peer()` 给出对端。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum CoreId {
    A,
    B,
}

impl CoreId {
    pub fn peer(self) -> CoreId {
        match self {
            CoreId::A => CoreId::B,
            CoreId::B => CoreId::A,
        }
    }
}

/// 间隔相位心跳调度。两核对 `phase` 取 `interval/2` 错开, 形成互插节奏。
#[derive(Debug, Clone, Copy)]
pub struct BeatSchedule {
    interval_ns: u64,
    phase_ns: u64,
}

impl BeatSchedule {
    /// `phase` 自动归一化到 `[0, interval)`。
    pub fn new(interval: Duration, phase: Duration) -> Self {
        let interval_ns = interval.as_nanos().max(1) as u64;
        let phase_ns = (phase.as_nanos() as u64) % interval_ns;
        Self { interval_ns, phase_ns }
    }

    /// 两核标准错相位: A 相位 0, B 相位 interval/2。
    pub fn staggered(interval: Duration) -> (BeatSchedule, BeatSchedule) {
        (
            BeatSchedule::new(interval, Duration::ZERO),
            BeatSchedule::new(interval, interval / 2),
        )
    }

    /// 给定 `start` 起点, 返回从 `now` 起到下一个本核起跳时刻的延时。
    /// 同拍时 (A 与 B 相位差 interval/2) 保证互插: A@0, B@Δ/2, A@Δ, B@3Δ/2 ...
    pub fn delay_to_next_beat(&self, start: Instant, now: Instant) -> Duration {
        if now <= start {
            return Duration::from_nanos(self.phase_ns);
        }
        let elapsed = now.duration_since(start).as_nanos() as u64;
        let steps = (elapsed.saturating_sub(self.phase_ns)) / self.interval_ns;
        let next_ns = self.phase_ns + (steps + 1) * self.interval_ns;
        Duration::from_nanos(next_ns.saturating_sub(elapsed))
    }
}

/// 栅栏令牌: 单调递增。写入 Run/事实时携带; 旧令牌写入作废 (防双主 / 陈旧核回写)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
pub struct FencingToken(pub u64);

impl FencingToken {
    pub fn next(self) -> Self {
        FencingToken(self.0 + 1)
    }
}

/// 一次心跳观测。跨进程时 `received_at` 用墙钟 (`SystemTime`), 使 stale 判定在跨进程下也成立。
#[derive(Debug, Clone)]
pub struct Beat {
    pub core: CoreId,
    pub seq: u64,
    pub fence: FencingToken,
    pub received_at: SystemTime,
    /// 自报负载 (0..=100), 供过载保护 (P3)
    pub load: u8,
}

/// 对端健康三态
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerHealth {
    Alive,
    Stale,
    Unknown,
}

/// 接管裁决 (纯判定, 无副作用)
#[derive(Debug, Clone, Copy)]
pub struct TakeoverDecision {
    pub takeover: bool,
    pub reason: &'static str,
    pub new_fence: FencingToken,
}

/// 心跳存储端口 (由宿主注入; 进程内用内存, 跨进程用文件)。
/// 适配器负责把心跳落盘/读盘, 使两个独立进程可互相探测。
#[async_trait::async_trait]
pub trait HeartbeatStore: Send + Sync {
    /// 持久化本核心跳; 返回是否成功写盘/落库。
    async fn write_beat(&self, beat: &Beat) -> bool;
    /// 读取对端上次心跳; 缺失返回 None。
    async fn read_beat(&self, core: CoreId) -> Option<Beat>;
}

/// 双核仲裁器: 纯判定机制, 无 I/O。
///
/// 状态只含 HA 自身三类: 本核 seq/fence、对端最后心跳、对端首次 stale 时刻。
/// 不持有任何业务状态 (守原则 4)。
pub struct DualArbiter {
    self_core: CoreId,
    /// 心跳新鲜窗口 (对端多久没跳算过期)
    window: Duration,
    /// 二次确认窗口: 持续 stale 这么久才判接管, 防 GC/时钟抖动误杀活核 (P2)
    confirm_window: Duration,
    /// 对端负载达到此值视为过载 → 不接管, 先本地降级 (P3)
    overload_threshold: u8,
    local_seq: Arc<Mutex<u64>>,
    local_fence: Arc<Mutex<FencingToken>>,
    self_load: Arc<Mutex<u8>>,
    peer: Arc<Mutex<Option<Beat>>>,
    peer_stale_since: Arc<Mutex<Option<Instant>>>,
}

impl DualArbiter {
    pub fn new(
        self_core: CoreId,
        window: Duration,
        confirm_window: Duration,
        overload_threshold: u8,
    ) -> Arc<Self> {
        Arc::new(Self {
            self_core,
            window,
            confirm_window,
            overload_threshold,
            local_seq: Arc::new(Mutex::new(0)),
            local_fence: Arc::new(Mutex::new(FencingToken(0))),
            self_load: Arc::new(Mutex::new(0)),
            peer: Arc::new(Mutex::new(None)),
            peer_stale_since: Arc::new(Mutex::new(None)),
        })
    }

    pub fn core(&self) -> CoreId {
        self.self_core
    }

    /// 上报本核当前负载 (供对端过载判定)。
    pub async fn set_self_load(&self, load: u8) {
        *self.self_load.lock().await = load.min(100);
    }

    async fn cur_fence(&self) -> FencingToken {
        *self.local_fence.lock().await
    }

    async fn bump_fence(&self) -> FencingToken {
        let mut f = self.local_fence.lock().await;
        *f = f.next();
        *f
    }

    /// 本核起跳: seq + fence 各 +1, 返回本拍 (供写盘)。
    pub async fn emit_self(&self) -> Beat {
        let seq = {
            let mut s = self.local_seq.lock().await;
            *s += 1;
            *s
        };
        let fence = self.bump_fence().await;
        let load = *self.self_load.lock().await;
        Beat {
            core: self.self_core,
            seq,
            fence,
            received_at: SystemTime::now(),
            load,
        }
    }

    /// 接收对端心跳: 只接受对端; 栅栏不回退 (旧/重放令牌忽略, 防双主回写)。
    pub async fn observe_peer(&self, beat: Beat) {
        if beat.core != self.self_core.peer() {
            return; // 非对端心跳, 忽略
        }
        let mut slot = self.peer.lock().await;
        if let Some(prev) = slot.as_ref() {
            if beat.fence < prev.fence {
                return; // 旧栅栏 → 忽略 (保护: 拒绝陈旧核重写事实)
            }
        }
        *slot = Some(beat);
    }

    /// 对端健康三态。
    pub async fn peer_health(&self) -> PeerHealth {
        let slot = self.peer.lock().await;
        match slot.as_ref() {
            None => PeerHealth::Unknown,
            Some(b) if b.received_at.elapsed().unwrap_or(Duration::ZERO) <= self.window => {
                PeerHealth::Alive
            }
            Some(_) => PeerHealth::Stale,
        }
    }

    /// 接管裁决 (互保护核心):
    /// - 对端 Alive: 健康不接管; 过载则 defer (P3)。
    /// - 对端 Stale/Unknown 且持续 ≥ confirm_window: 接管并提升 fence (防双主)。
    pub async fn should_takeover(&self, now: Instant) -> TakeoverDecision {
        let (health, load) = {
            let slot = self.peer.lock().await;
            match slot.as_ref() {
                None => (PeerHealth::Unknown, 0u8),
                Some(b) if b.received_at.elapsed().unwrap_or(Duration::ZERO) <= self.window => {
                    (PeerHealth::Alive, b.load)
                }
                Some(b) => (PeerHealth::Stale, b.load),
            }
        };

        let confirmed = {
            let mut ss = self.peer_stale_since.lock().await;
            match health {
                PeerHealth::Alive => {
                    *ss = None;
                    false
                }
                _ => {
                    if ss.is_none() {
                        *ss = Some(now);
                    }
                    now.duration_since(ss.unwrap_or(now)) >= self.confirm_window
                }
            }
        };

        match health {
            PeerHealth::Alive => {
                if load >= self.overload_threshold {
                    TakeoverDecision {
                        takeover: false,
                        reason: "peer-overloaded-defer",
                        new_fence: self.cur_fence().await,
                    }
                } else {
                    TakeoverDecision {
                        takeover: false,
                        reason: "peer-healthy",
                        new_fence: self.cur_fence().await,
                    }
                }
            }
            PeerHealth::Stale | PeerHealth::Unknown => {
                if !confirmed {
                    TakeoverDecision {
                        takeover: false,
                        reason: "confirming",
                        new_fence: self.cur_fence().await,
                    }
                } else {
                    // 接管: 新主 fence 必须高于对端最后已知 fence, 才能 fence 掉可能复活的旧核 (P1)
                    let peer_fence = self
                        .peer
                        .lock()
                        .await
                        .as_ref()
                        .map(|b| b.fence)
                        .unwrap_or(FencingToken(0));
                    let mut f = self.local_fence.lock().await;
                    let base = f.0.max(peer_fence.0);
                    *f = FencingToken(base + 1);
                    TakeoverDecision {
                        takeover: true,
                        reason: if health == PeerHealth::Stale {
                            "peer-stale"
                        } else {
                            "peer-absent"
                        },
                        new_fence: *f,
                    }
                }
            }
        }
    }
}

/// 双核守护循环: 按**错相位**起跳 → 写本核心跳 → 读对端心跳并观察 → 裁决接管 → 执行恢复。
///
/// 错相位保证两个核在自己两次心跳之间都恰好看到对方一次新鲜心跳。
pub struct DualGuard {
    arbiter: Arc<DualArbiter>,
    schedule: BeatSchedule,
    start: Instant,
    store: Arc<dyn HeartbeatStore>,
    recovery: Arc<dyn RecoveryAction>,
}

impl DualGuard {
    pub fn new(
        arbiter: Arc<DualArbiter>,
        schedule: BeatSchedule,
        store: Arc<dyn HeartbeatStore>,
        recovery: Arc<dyn RecoveryAction>,
    ) -> Self {
        Self {
            arbiter,
            schedule,
            start: Instant::now(),
            store,
            recovery,
        }
    }

    /// 启动守护循环 (一直跑, 直到被 abort)。
    pub async fn run(self) {
        // 先对齐到本核相位 (错相位起点), 再按 interval 循环。
        let first = self.schedule.delay_to_next_beat(self.start, Instant::now());
        tokio::time::sleep(first).await;
        loop {
            let beat = self.arbiter.emit_self().await;
            self.store.write_beat(&beat).await;

            if let Some(peer_beat) = self.store.read_beat(self.arbiter.core().peer()).await {
                self.arbiter.observe_peer(peer_beat).await;
            }

            let decision = self.arbiter.should_takeover(Instant::now()).await;
            if decision.takeover {
                tracing::warn!(
                    core = ?self.arbiter.core(),
                    reason = decision.reason,
                    new_fence = decision.new_fence.0,
                    "双核接管对端"
                );
                self.recovery.recover().await;
            }

            tokio::time::sleep(self.schedule.interval_ns_to_duration()).await;
        }
    }
}

impl BeatSchedule {
    fn interval_ns_to_duration(self) -> Duration {
        Duration::from_nanos(self.interval_ns)
    }
}

/// 文件心跳存储: 把心跳落 `~/.bolloon/kernel-ha/<core>.heartbeat.json` (对齐 TS 侧口径)。
/// 跨进程时 `received_at` 以 epoch 毫秒持久化, 读回重建 `SystemTime`, 使 stale 判定成立。
pub struct FileHeartbeatStore {
    dir: PathBuf,
}

impl FileHeartbeatStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn path(&self, core: CoreId) -> PathBuf {
        let name = match core {
            CoreId::A => "a",
            CoreId::B => "b",
        };
        self.dir.join(format!("{name}.heartbeat.json"))
    }
}

#[async_trait::async_trait]
impl HeartbeatStore for FileHeartbeatStore {
    async fn write_beat(&self, beat: &Beat) -> bool {
        let _ = tokio::fs::create_dir_all(&self.dir).await;
        let last_beat = beat
            .received_at
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let v = serde_json::json!({
            "core": if beat.core == CoreId::A { "a" } else { "b" },
            "seq": beat.seq,
            "fence": beat.fence.0,
            "lastBeat": last_beat,
            "load": beat.load,
        });
        let target = self.path(beat.core);
        let tmp = format!("{}.tmp", target.display());
        match tokio::fs::write(&tmp, serde_json::to_vec(&v).unwrap_or_default()).await {
            Ok(_) => tokio::fs::rename(&tmp, &target).await.is_ok(),
            Err(_) => false,
        }
    }

    async fn read_beat(&self, core: CoreId) -> Option<Beat> {
        let raw = tokio::fs::read_to_string(self.path(core)).await.ok()?;
        let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
        let last_beat = v["lastBeat"].as_i64()?;
        let received_at = UNIX_EPOCH + Duration::from_millis(last_beat.max(0) as u64);
        Some(Beat {
            core,
            seq: v["seq"].as_u64().unwrap_or(0),
            fence: FencingToken(v["fence"].as_u64().unwrap_or(0)),
            received_at,
            load: v["load"].as_u64().unwrap_or(0) as u8,
        })
    }
}

/// 双核 HA 配置 (默认值可经环境变量覆盖; 此处给保守默认)。
#[derive(Debug, Clone)]
pub struct KernelHaConfig {
    pub interval: Duration,
    /// 心跳新鲜窗口 (对端多久没跳算过期)
    pub window: Duration,
    /// 二次确认窗口 (持续 stale 这么久才判接管, 防误杀)
    pub confirm_window: Duration,
    /// 对端负载达到此值视为过载 → 不接管
    pub overload_threshold: u8,
    /// 心跳文件目录
    pub home: PathBuf,
}

impl KernelHaConfig {
    pub fn default_with_home(home: PathBuf) -> Self {
        Self {
            interval: Duration::from_secs(5),
            window: Duration::from_secs(15),
            confirm_window: Duration::from_secs(6),
            overload_threshold: 85,
            home,
        }
    }
}

/// 双核心跳目录默认 `~/.bolloon/kernel-ha`; `BOLLOON_HA_HOME` 可重定向。
pub fn ha_home_dir() -> PathBuf {
    if let Ok(p) = std::env::var("BOLLOON_HA_HOME") {
        return PathBuf::from(p);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".bolloon").join("kernel-ha")
}

/// 为单个核心启一个错相位守护循环 (后台 detached task)。
pub fn spawn_kernel_ha(
    core: CoreId,
    cfg: &KernelHaConfig,
    recovery: Arc<dyn RecoveryAction>,
) -> tokio::task::JoinHandle<()> {
    let phase = if core == CoreId::A {
        Duration::ZERO
    } else {
        cfg.interval / 2
    };
    let schedule = BeatSchedule::new(cfg.interval, phase);
    let arbiter = DualArbiter::new(core, cfg.window, cfg.confirm_window, cfg.overload_threshold);
    let store = Arc::new(FileHeartbeatStore::new(cfg.home.clone()));
    let guard = DualGuard::new(arbiter, schedule, store, recovery);
    tokio::spawn(guard.run())
}

/// 按环境变量接线双核 HA:
/// - `BOLLOON_HA=1` (或 `true`): 按 `BOLLOON_KERNEL_CORE` (A|B, 默认 A) 启一个核;
///   两个独立进程各选一个核即可互维互保。
/// - `BOLLOON_HA=both`: 同进程启 A+B 两核 (仅本地演示, 无进程级崩溃隔离)。
/// - 未设置 / `0` / `off`: 不启 (默认关, 不影响现有行为)。
pub fn spawn_kernel_ha_from_env(recovery: Arc<dyn RecoveryAction>) -> Vec<tokio::task::JoinHandle<()>> {
    let ha = std::env::var("BOLLOON_HA").unwrap_or_default();
    let ha_lc = ha.to_ascii_lowercase();
    if ha_lc.is_empty() || ha_lc == "0" || ha_lc == "off" {
        return Vec::new();
    }
    let cfg = KernelHaConfig::default_with_home(ha_home_dir());
    if ha_lc == "both" {
        return vec![
            spawn_kernel_ha(CoreId::A, &cfg, recovery.clone()),
            spawn_kernel_ha(CoreId::B, &cfg, recovery),
        ];
    }
    let core = match std::env::var("BOLLOON_KERNEL_CORE").ok().as_deref() {
        Some("B") | Some("b") => CoreId::B,
        _ => CoreId::A,
    };
    vec![spawn_kernel_ha(core, &cfg, recovery)]
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::Mutex as TokioMutex;

    /// 进程内内存心跳存储, 用于双核互测。
    struct MemStore {
        a: TokioMutex<Option<Beat>>,
        b: TokioMutex<Option<Beat>>,
    }

    impl MemStore {
        fn new() -> Self {
            Self {
                a: TokioMutex::new(None),
                b: TokioMutex::new(None),
            }
        }
    }

    #[async_trait::async_trait]
    impl HeartbeatStore for MemStore {
        async fn write_beat(&self, beat: &Beat) -> bool {
            let m = if beat.core == CoreId::A { &self.a } else { &self.b };
            *m.lock().await = Some(beat.clone());
            true
        }
        async fn read_beat(&self, core: CoreId) -> Option<Beat> {
            let m = if core == CoreId::A { &self.a } else { &self.b };
            m.lock().await.clone()
        }
    }

    #[test]
    fn staggered_phase_interleaves() {
        let (sa, sb) = BeatSchedule::staggered(Duration::from_millis(100));
        let start = Instant::now();
        // A 拍: 0, 100, 200, 300; B 拍: 50, 150, 250, 350
        let mut cursor = start;
        let mut a_times = Vec::new();
        let mut b_times = Vec::new();
        for _ in 0..4 {
            let d = sa.delay_to_next_beat(start, cursor);
            let beat_at = cursor + d;
            a_times.push(beat_at.duration_since(start).as_millis() as u64);
            cursor = beat_at + Duration::from_nanos(1); // 略过本拍, 推进到下一拍
        }
        cursor = start;
        for _ in 0..4 {
            let d = sb.delay_to_next_beat(start, cursor);
            let beat_at = cursor + d;
            b_times.push(beat_at.duration_since(start).as_millis() as u64);
            cursor = beat_at + Duration::from_nanos(1);
        }
        // 互插: A0<B0<A1<B1<...
        assert_eq!(a_times, vec![0, 100, 200, 300]);
        assert_eq!(b_times, vec![50, 150, 250, 350]);
        for i in 0..3 {
            assert!(a_times[i] < b_times[i] && b_times[i] < a_times[i + 1]);
        }
    }

    #[tokio::test]
    async fn peer_alive_no_takeover() {
        let arb = DualArbiter::new(CoreId::A, Duration::from_millis(100), Duration::from_millis(50), 90);
        arb.observe_peer(Beat {
            core: CoreId::B,
            seq: 1,
            fence: FencingToken(1),
            received_at: SystemTime::now(),
            load: 10,
        })
        .await;
        assert_eq!(arb.peer_health().await, PeerHealth::Alive);
        let d = arb.should_takeover(Instant::now()).await;
        assert!(!d.takeover);
        assert_eq!(d.reason, "peer-healthy");
    }

    #[tokio::test]
    async fn peer_overloaded_defers() {
        let arb = DualArbiter::new(CoreId::A, Duration::from_millis(100), Duration::from_millis(50), 80);
        arb.observe_peer(Beat {
            core: CoreId::B,
            seq: 1,
            fence: FencingToken(1),
            received_at: SystemTime::now(),
            load: 95, // 过载
        })
        .await;
        let d = arb.should_takeover(Instant::now()).await;
        // 对端活着但过载 → 不接管 (P3), 先本地降级
        assert!(!d.takeover);
        assert_eq!(d.reason, "peer-overloaded-defer");
    }

    #[tokio::test]
    async fn stale_then_takeover_bumps_fence() {
        let arb = DualArbiter::new(CoreId::A, Duration::from_millis(30), Duration::from_millis(40), 90);
        // 对端最后一次心跳, 立刻过期
        arb.observe_peer(Beat {
            core: CoreId::B,
            seq: 1,
            fence: FencingToken(5),
            received_at: SystemTime::now() - Duration::from_millis(200),
            load: 10,
        })
        .await;
        // 持续 stale 不足 confirm_window → 仍在确认
        let early = arb.should_takeover(Instant::now()).await;
        assert!(!early.takeover);
        assert_eq!(early.reason, "confirming");

        // 已过 confirm_window → 接管并提升 fence (防双主)
        tokio::time::sleep(Duration::from_millis(60)).await;
        let d = arb.should_takeover(Instant::now()).await;
        assert!(d.takeover);
        assert_eq!(d.reason, "peer-stale");
        assert!(d.new_fence > FencingToken(5));
    }

    #[tokio::test]
    async fn old_fence_replay_rejected() {
        let arb = DualArbiter::new(CoreId::A, Duration::from_millis(100), Duration::from_millis(50), 90);
        arb.observe_peer(Beat {
            core: CoreId::B,
            seq: 2,
            fence: FencingToken(10),
            received_at: SystemTime::now(),
            load: 0,
        })
        .await;
        // 陈旧核用更旧的 fence 重放 → 被忽略, 不刷新 stale 计时
        arb.observe_peer(Beat {
            core: CoreId::B,
            seq: 1,
            fence: FencingToken(3),
            received_at: SystemTime::now() - Duration::from_millis(500),
            load: 0,
        })
        .await;
        assert_eq!(arb.peer_health().await, PeerHealth::Alive);
    }

    #[tokio::test]
    async fn two_cores_exchange_beats_via_store() {
        let store = Arc::new(MemStore::new());
        let (sa, sb) = BeatSchedule::staggered(Duration::from_millis(20));
        let arb_a = DualArbiter::new(CoreId::A, Duration::from_millis(150), Duration::from_millis(50), 90);
        let arb_b = DualArbiter::new(CoreId::B, Duration::from_millis(150), Duration::from_millis(50), 90);
        let guard_a = DualGuard::new(arb_a.clone(), sa, store.clone(), Arc::new(crate::ha::NoopRecovery));
        let guard_b = DualGuard::new(arb_b.clone(), sb, store.clone(), Arc::new(crate::ha::NoopRecovery));
        let h_a = tokio::spawn(guard_a.run());
        let h_b = tokio::spawn(guard_b.run());

        // 错相位互测: 150ms 足够双方各看到对方多次新鲜心跳
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(arb_a.peer_health().await, PeerHealth::Alive);
        assert_eq!(arb_b.peer_health().await, PeerHealth::Alive);

        h_a.abort();
        h_b.abort();
    }

    #[tokio::test]
    async fn file_store_roundtrip_and_stale() {
        let dir = std::env::temp_dir().join(format!("bolloon-ha-test-{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&dir).await;
        let store = FileHeartbeatStore::new(dir.clone());
        let beat = Beat {
            core: CoreId::B,
            seq: 7,
            fence: FencingToken(12),
            received_at: SystemTime::now() - Duration::from_secs(10), // 故意陈旧
            load: 20,
        };
        assert!(store.write_beat(&beat).await);
        let read = store.read_beat(CoreId::B).await.expect("应读回");
        assert_eq!(read.seq, 7);
        assert_eq!(read.fence, FencingToken(12));
        // 10s 前的心跳, 落盘读回后误差在亚秒级; 以秒粒度校验往返保真
        assert_eq!(
            read
                .received_at
                .elapsed()
                .unwrap_or(Duration::ZERO)
                .as_secs(),
            10
        );
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
}
