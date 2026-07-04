# 案例：多规则训练突破（LMT-twister V26.7）

> **通用方法论**：消融实验设计
> **项目背景**：LMT-twister因果推理系统
> **核心教训**：训练数据比架构更重要

---

## 背景

V23-V26.6尝试了15种架构改进，都失败了。V26.7发现：问题不是架构，而是训练数据。

## 关键发现

### 多规则训练

```
V26.7 C3-multi-rule：
  在规则A/B/C上混合训练
  rule_B: 0% → 10.22%（从无到有）
  rule_C: 0% → 10.35%（从无到有）

对比V26.7 C1-baseline：
  只在规则A上训练
  rule_B: 0%
  rule_C: 0%
```

### 训练数据vs架构

```
V26.4-V26.6：改进架构 → 失败
V26.7：改进训练数据 → 成功

结论：
  问题不是架构，而是训练数据
  模型需要见过多种规则，才能学会"规则"的概念
```

## 通用教训

1. **先检查训练数据**：在改进架构之前，先检查训练数据是否足够
2. **多样性比复杂性更重要**：简单的多规则训练比复杂的架构更有效
3. **"记住"vs"理解"**：多规则训练帮助模型从"记住"进化到"理解"

## 可迁移的消融设计

```python
def multi_rule_ablation(V, rules, n_steps):
    """
    多规则训练消融实验
    
    测试：训练数据多样性对规则泛化的影响
    """
    experiments = [
        ("单规则", [rules[0]]),           # 只训练规则A
        ("双规则", rules[:2]),            # 训练规则A/B
        ("三规则", rules[:3]),            # 训练规则A/B/C
        ("全规则", rules),                # 训练所有规则
    ]
    
    results = []
    for name, train_rules in experiments:
        model = train(train_rules, n_steps)
        acc = {r: evaluate(model, r) for r in rules}
        results.append((name, acc))
    
    return results
```