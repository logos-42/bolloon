---
name: mt5-backtest
description: MT5 策略回测验证流程 — MCP 拉真实数据 → 回测 → walk-forward/跨品种防过拟合 → 带数据表格的中文报告。Use when 用户要做 MT5 回测/策略验证/参数检验。
---

# MT5 回测验证流程

## 触发条件
- 用户要回测 MT5 策略 / 验证参数 / 检验 edge
- 涉及 EURUSD 等品种 + 周期 (H1/M15) 的历史数据

## 流程

1. **环境检查**
   - MCP: `curl http://127.0.0.1:22346` 可达 (terminal MCP, Bearer token 见 memory)
   - MetaEditor MCP: `http://127.0.0.1:22345` (compile_file 优先于 F7)
   - MT5 数据目录: `D:\AI\MT5\MT5-hibs\` (dengyu/ 子目录是策略工程)

2. **拉真实数据 (不用 Python 合成!)**
   - 用 `dengyu/py/mcp_client.py` (init/session/调用封装, curl 输出 LF 需 partition('\n\n'))
   - 先 `get_workspace_info`, 再拉品种历史 (BTCUST H1 / ETHUST H1 / EURUSD M15)

3. **回测**
   - EA 编译用 MCP compile_file; 注意: 编译后 EA 会从图表移除, 需重新拖回
   - 长任务 tee 日志; 后台命令首行 `# 注释` 防 BOM 污染

4. **防过拟合验证 (必做)**
   - walk-forward 滚动 (如 5.2y 分块) / 跨品种 / 分段时间段
   - 静态胜率 vs WF 胜率对比 (静态 56% 可能 WF 后消失 → 过拟合)
   - 扣点差成本后算年化 (2bps 成本对高频是毁灭性的)
   - 报告要分块数据表格 + 来源标注

5. **诚实负面结论可接受** — 用户偏好有证据的负面结果, 不要粉饰

## 陷阱
- 价格场无记忆 H=0.49, 波动率场长记忆 H=0.84 — 方向预测到天花板, 记忆用于仓位/regime
- 方向策略 (反转×高波动) WF 后 0.6bps/笔 → 不可交易
- 杠杆物理: 年化 100% 需要 203% 回撤

## 验证
- 报告含: 数据源 (file:line) + 分块结果表 + 归因分离 (数据/环境因子 vs 机制因子)
