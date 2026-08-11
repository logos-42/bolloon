/**
 * loop-noise.ts — 良性连接拆除噪音抑制 (借鉴 Hermes tui_gateway/loop_noise.py)
 *
 * Hermes 问题: Desktop 客户端强关 WebSocket 时, gateway 还有 pending socket 操作,
 *   asyncio transport teardown 对每个 _call_connection_lost 回调打一条完整 traceback,
 *   单次断开可刷 50+ 条相同 ConnectionResetError/WinError 10054 进 errors.log (#50005).
 *
 * Bolloon 等价: SSE/HTTP 客户端断开后, 服务端向已关闭的 res 写消息 → 每次广播抛
 *   "write EPIPE / write after end / 连接被重置"。这不是可行动的错误 — 是对端在
 *   写 drain 前挂线的预期副作用。这里对"拆除期写失败"这类良性错误做一次过滤,
 *   把同类错误折叠成一行 debug, 其余错误原样交给默认逻辑, 真实的循环 bug 仍会暴露。
 *
 * 设计要点 (对齐 hermes):
 *   - 同时看错误类型 AND 写路径标记 (broadcast 的 res.write) 才吞 — 其它地方抛同样错误
 *     不被误吞 (对应 hermes 的 _call_connection_lost gating)。
 *   - 同类错误窗口节流 (channel_directory 模式): 同一 (类别, 摘要) 窗口内只 warn 一次,
 *     复用 delivery-ledger 已有的 shouldWarn 心智。
 */

/** 良性拆除期写失败: 对端挂线 / 写已结束的流。等价 hermes 的 ConnectionReset/Aborted/BrokenPipe。 */
const BENIGN_WRITE_PATTERNS: RegExp[] = [
  /write EPIPE/i,
  /write after end/i,
  /ECONNRESET|connection (reset|aborted)|10054|10053/i,
  /Cannot (write|set headers) after (the client|they) (are |is |has )?(closed|ended)/i,
  /socket hang up/i,
  /broken pipe/i,
];

/**
 * 一条错误是否属于"写给已断开客户端"的良性噪音。
 * 双重判定等价 hermes 的 (错误类型 + _call_connection_lost 回调 gating):
 *   - 类型/消息命中拆除类写失败 (ConnectionReset/BrokenPipe/写已结束)
 *   - 且调用点本来就是"写路径" — 由 guardClientWriteNoise 只在 res.write 处调用保证
 */
export function isBenignClientWriteNoise(err: unknown): boolean {
  const msg = String((err as any)?.message || err || '');
  return BENIGN_WRITE_PATTERNS.some((re) => re.test(msg));
}

/** 同类错误节流器: 同 (类别, 摘要) 窗口内返回 false (不重复 warn), 窗口外返回 true 并刷新。 */
export class NoiseThrottle {
  private last = new Map<string, number>();
  constructor(private readonly windowMs = 5 * 60 * 1000) {}

  shouldWarn(category: string, detail: string): boolean {
    const key = `${category}|${detail.slice(0, 80)}`;
    const now = Date.now();
    const last = this.last.get(key) ?? 0;
    if (now - last < this.windowMs) return false;
    this.last.set(key, now);
    return true;
  }

  reset(): void {
    this.last.clear();
  }
}

/**
 * 包装一个"可能抛拆除期写失败"的写操作:
 *   - 良性噪音 → 静默吞一次 (不抛出, 不打印), 仅按节流器偶尔 debug 一行
 *   - 其它错误 → 原样抛出 / 转交 onError, 不掩盖真实问题
 *
 * @param fn 实际写操作 (抛异常或 reject)
 * @param opts 诊断标签 + 可选节流器 (默认全局单例) + 可选 onError 回调 (捕获真实错误)
 */
export async function guardClientWriteNoise(
  fn: () => Promise<void>,
  opts: { label: string; throttle?: NoiseThrottle; onError?: (e: unknown) => void } = { label: 'write' },
): Promise<void> {
  const throttle = opts.throttle ?? globalNoiseThrottle;
  try {
    await fn();
  } catch (e: unknown) {
    if (isBenignClientWriteNoise(e)) {
      // 良性: 折叠成一行 (节流), 不抛出
      if (throttle.shouldWarn(opts.label, String((e as any)?.message || e))) {
        console.debug(`[loop-noise] 已抑制良性客户端断开写失败 (${opts.label}): ${String((e as any)?.message || '').slice(0, 120)}`);
      }
      return;
    }
    if (opts.onError) opts.onError(e);
    else throw e;
  }
}

/** 全局默认节流器 (server 生命期复用, 跨连接共享告警窗口)。 */
export const globalNoiseThrottle = new NoiseThrottle();