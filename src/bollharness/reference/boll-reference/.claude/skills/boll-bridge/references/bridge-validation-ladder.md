# Bridge Validation Ladder

## Principle

把上线当确认，不当调试。

任何 bridge 改动都尽量沿这条梯子往上走。不能跳过某一层时，要显式说明为什么跳过，以及风险留在哪。

## Level 0: Pure Logic

适用：

- 文件分类
- placeholder / verdict
- phase -> event 映射
- config 解析

要求：

- 为纯函数补单元测试
- 把历史 bug 变成固定回归样例

## Level 1: Local Process

适用：

- subprocess 生命周期
- stdout/stderr 捕获
- timeout / retry / output scan

要求：

- 真起本地 subprocess
- 验证非零退出、超时、输出文件扫描

注意：

- 这层还没覆盖 `/api/bridge/*`
- 这层通过不代表 worker 主链通过

## Level 2: Local Same-System Integration

这是 bridge 最缺的一层，也是默认新增测试的优先位置。

目标：

- 在本地启动 test backend
- 用真实 bridge worker 跑 `accept -> heartbeat/events -> complete`
- 验证终态、artifacts、events、status 一致

至少覆盖：

- success
- executor non-zero exit
- complete failure fallback
- placeholder 不会伪装成真实 delivery

这层允许对 executor 做受控替身，但不允许跳过 bridge worker 本身。

## Level 3: Prod-Like Runtime Smoke

目标：

- 验证 systemd / runtime / Claude CLI 这一层不是隐形变量

至少核实：

- `claude_bin`
- `HOME`
- `CLAUDE_CONFIG_DIR`
- auth status / token freshness
- repo_root / workdir / tmp 权限
- backend base_url 可达

这层可以是手工 smoke，但必须留下证据，不要只口头说“服务器上试过了”。

## Level 4: Single-Instance Canary

目标：

- 用 1 个 bridge 实例验证真实生产链
- 把生产当最终确认，不把多实例变量一起混进来

要求：

- 明确 run_id
- 留下事件时间线
- 验证 result/status/inbox 等下游语义

## Level 5: Multi-Instance Rollout

只有在前四层都足够扎实时再做。

重点看：

- accept 抢单一致性
- compute_node 观测
- 长时间无 complete 的告警
- 并发下的 lease 与状态 freshness

## Release Checklist

- 是否存在本地可重复验证，而不是只能去服务器碰运气？
- 是否明确区分了 executor exit、artifact verdict、run final status？
- 是否验证了失败路径，而不是只验证成功路径？
- 是否记录了哪些验证没做，以及为什么没做？
- 是否把新教训沉淀回 skill / reference，而不是只写在一次性回复里？
