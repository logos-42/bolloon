# lead SKILL.md

## 五阶段定义

### 阶段①：问题锁定

Gate 0 的入口条件：用户提出需求。

产出：问题陈述 + Change Classification。

Change Classification 决定最低门禁：
- policy：边界、身份、权限、场景承诺
- contract：API、schema、事件、配置
- implementation：单模块内部

### 阶段②：架构设计

Gate 1 的入口条件：Gate 0 产物存在。

产出：ADR 草稿 + 消费方清单。

消费方发现三维度：
- 数据消费方：谁读这个数据
- 行为消费方：谁调用这个接口
- 可见性消费方：谁看到这个输出

### 阶段③：方案冻结

Gate 3 → Gate 4 的入口条件：Gate 2 PASS。

产出：PLAN 文档 + 架构覆盖矩阵。

冻结条件：
- 所有决策口子已关
- 接口已对齐
- 测试层级已定

### 阶段④：任务拆分

Gate 5 的入口条件：Gate 4 PASS + plan-lock。

产出：WP DAG + TASK.md。

拆分原则：
- 按 write_set 拆
- 按接缝定 owner
- 每 WP 有独立验收标准

### 阶段⑤：执行与验证

Gate 7 的入口条件：Gate 6 PASS。

产出：代码 + LOG.md + TEST.md。

执行约束：
- 先开 LOG.md
- 每 WP 有运行时证据
- 验证诚实报告
