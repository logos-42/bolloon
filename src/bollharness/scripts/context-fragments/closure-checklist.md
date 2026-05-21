## Issue 闭环检查清单

你正在编辑 issue 文档。关闭 issue 前必须逐条确认：

1. **prevention_status 是否 closed？** 如果是 open，说明复发路径未关闭，不得标 Fixed
2. **mechanism_layer 是否声明？** 必须指定防护机制：guard / test / type / convention
3. **有无具体的防护措施描述？** 不能只写"已修复"，必须说明如何防止复发
4. **Guard > Memory 原则**：如果防护靠"记住规则"，则 prevention 不算 closed

**行为约束**: 你不得在 prevention_status 为 open 的情况下将 status 改为 fixed。
如果根因分析表明无法机械化防护，必须显式标注 `mechanism_layer: convention` 并说明原因。

检查顺序：根因 -> 复发路径 -> 防护机制 -> 标记状态。不得跳过中间步骤。
