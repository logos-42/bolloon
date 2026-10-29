//! 经济层观察者 —— 把 `KernelLoop` 的事实喂给 `bolloon-econ`。
//!
//! 这是"旁路"的关键一环: 循环本身**不知道**经济层的存在, 也不为它改一行语义;
//! 观察者只是把已经发生的事实 (哪一轮、用了多少 token、哪个工具、成败、耗时)
//! 转成用量事件。经济层关闭时, 这个观察者根本不会被挂上。
//!
//! 诚实边界: 循环不暴露"每次尝试 vs 重试"的区分, 也不暴露缓存命中 token,
//! 所以这两个字段如实留空, 不拿 0 冒充。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use async_trait::async_trait;
use bolloon_econ::{CallCtx, MeterStatus, ShadowEconomy};
use bolloon_harness::{GateOutcome, ToolCall};

use crate::kernel_loop::{LoopObserver, LoopStep, StopReason};

/// 把一轮循环的事实记进经济层。
pub struct EconomyObserver {
    econ: Arc<ShadowEconomy>,
    ctx: CallCtx,
    provider: String,
    model: String,
    /// 本轮模型的起跑时刻 (拿不到单价也能算耗时)
    turn_started: Mutex<Option<Instant>>,
    /// 已记录过失败 (避免把同一轮重复标 failed)
    saw_failure: AtomicBool,
}

impl EconomyObserver {
    pub fn new(
        econ: Arc<ShadowEconomy>,
        ctx: CallCtx,
        provider: impl Into<String>,
        model: impl Into<String>,
    ) -> Self {
        Self {
            econ,
            ctx,
            provider: provider.into(),
            model: model.into(),
            turn_started: Mutex::new(None),
            saw_failure: AtomicBool::new(false),
        }
    }

    pub fn ctx(&self) -> &CallCtx {
        &self.ctx
    }
}

#[async_trait]
impl LoopObserver for EconomyObserver {
    async fn on_turn_start(&self, _turn: u32, _max_steps: u32) {
        *self.turn_started.lock().unwrap() = Some(Instant::now());
    }

    async fn on_tool_result(&self, _turn: u32, call: &ToolCall, outcome: &GateOutcome) {
        let (ok, evidence) = match &outcome.result {
            Some(r) => (r.ok, r.evidence.clone()),
            None => (
                false,
                outcome
                    .denied
                    .as_ref()
                    .map(|d| serde_json::json!({ "denied": d.reason, "policy": d.policy })),
            ),
        };
        self.econ
            .on_tool_call(&self.ctx, &call.name, ok, outcome.elapsed_ms, evidence);
    }

    async fn on_turn_end(&self, _turn: u32, step: &LoopStep) {
        let Some(resp) = step.response.as_ref() else {
            return;
        };
        let elapsed = self
            .turn_started
            .lock()
            .unwrap()
            .take()
            .map(|t| t.elapsed().as_millis() as u64)
            .unwrap_or(0);
        // usage 全 0 = 供应商没给 ⇒ 如实记 None (不是"零 token")
        let (tin, tout) = {
            let u = &resp.usage;
            if u.prompt_tokens == 0 && u.completion_tokens == 0 {
                (None, None)
            } else {
                (Some(u.prompt_tokens), Some(u.completion_tokens))
            }
        };
        let status = match &step.stop {
            Some(StopReason::Failed(_)) => {
                self.saw_failure.store(true, Ordering::Relaxed);
                MeterStatus::Failed
            }
            Some(StopReason::Aborted) => MeterStatus::Cancelled,
            _ => MeterStatus::Ok,
        };
        let model = if resp.model.trim().is_empty() {
            self.model.clone()
        } else {
            resp.model.clone()
        };
        self.econ.on_model_call(
            &self.ctx,
            &self.provider,
            &model,
            tin,
            tout,
            None, // 循环没暴露缓存命中 token: 留空, 不编
            status,
            elapsed,
            None,
        );
    }
}
