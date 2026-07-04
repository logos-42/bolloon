---
name: 消融实验技能-指标体系
description: 消融实验的指标体系——主指标、基线指标、辅助指标的定义、计算方法和使用规范。适用于任何需要设计评估指标的机器学习/深度学习项目。Use when the user 提到"评估指标"、"随机基线"、"指标计算"、"指标定义",或想理解消融实验中各指标的含义和相互关系。
author: 元木
updated: 2026-06-29
source: original
---

# 消融实验指标体系

> **"先算基线,再算模型,最后比较。"**  
> **指标之间不能重叠,否则就是假阳性。**  
> **主指标是唯一的裁判,基线是它的底线。**

主 skill [消融实验技能/](../SKILL.md) 讲"总览",本 skill 讲"指标体系"。

---

## 一句话心法

> **主指标是唯一的裁判,基线是它的底线,其余指标是辅助验证。**

---

## 核心内容

### 指标分类(普适性)

| 类别 | 角色 | 定义 | 何时使用 |
|:-----|:-----|:-----|:---------|
| **主指标** | 裁判 | 模型在核心任务上的表现 | 每次实验必算 |
| **基线指标** | 底线 | 随机猜测的准确率 | 每次实验必算,用于假阳性检测 |
| **辅助指标** | 验证 | 模型在其他维度的表现 | 辅助验证,不能替代主指标 |
| **约束指标** | 检查 | 模型是否学到东西 | 检查模型基本能力 |

---

### 主指标:核心任务准确率

**定义**:模型在核心任务上的准确率——给定输入,模型能否正确预测输出。

**计算方式**:
```python
def calc_main_metric(predictions, targets):
    """主指标:核心任务准确率
    
    predictions: 模型预测
    targets: 真实标签
    """
    correct = sum(1 for p, t in zip(predictions, targets) if p == t)
    return correct / len(targets)
```

**判定标准**:
- 主指标 > 5% → 成功,机制有效
- 主指标 > 2% → 部分成功,需要进一步验证
- 主指标 < 2% → 失败,机制无效

---

### 基线指标:随机基线

**定义**:纯随机猜测能达到的准确率,是主指标的最低门槛。

**计算方式**:
```python
def calc_random_baseline(vocab_size, num_predictions):
    """随机基线 = (1/V)^n
    
    vocab_size: 词汇表大小(或输出空间大小)
    num_predictions: 需要猜对的预测数量
    """
    return (1 / vocab_size) ** num_predictions

# 示例:V=10000, n=2
random_baseline = (1/10000) ** 2  # = 0.00000001
```

**关键点**:
- 随机基线必须在每次实验前计算
- 如果随机基线 ≈ 1.0,说明评估函数有bug
- 主指标必须 > 随机基线 × 10才算有效

---

### 辅助指标:其他维度验证

**定义**:模型在其他维度的表现,用于辅助验证。

**使用规范**:
- 仅作为辅助验证,不能替代主指标
- 不能与主指标重叠(否则假阳性)

```python
# 错误做法:辅助指标和主指标用同一份数据
main_metric = evaluate(model, data)  # 和辅助指标一样 → 假阳性

# 正确做法:使用独立的评估数据集
main_metric = evaluate(model, main_data)      # 主指标数据
aux_metric = evaluate(model, aux_data)        # 辅助指标数据(独立)
```

---

### 约束指标:基本能力检查

**定义**:模型是否学到东西的检查指标。

**常见约束指标**:
- PPL(困惑度):模型对数据的"困惑程度",越低越好
- Loss:训练损失,越低越好

**约束范围**:
```python
def check_constraint(metric, min_val, max_val):
    """检查约束指标是否在合理范围"""
    if metric < min_val:
        print(f"⚠️ 指标过低({metric}),可能过拟合")
        return False
    elif metric > max_val:
        print(f"⚠️ 指标过高({metric}),模型可能没学到东西")
        return False
    return True
```

---

## 代码示例:完整指标计算

```python
import math

def calc_all_metrics(model, test_data, config):
    """计算消融实验的所有指标
    
    config: 字典,包含:
        - vocab_size: 输出空间大小
        - num_predictions: 预测数量
        - main_task: 主指标计算函数
        - aux_task: 辅助指标计算函数
    """
    
    # 1. 随机基线(必须先算)
    random_baseline = (1 / config["vocab_size"]) ** config["num_predictions"]
    
    # 2. 主指标:核心任务准确率
    main_metric = config["main_task"](model, test_data)
    
    # 3. 辅助指标:其他维度验证(独立数据集)
    aux_metric = config["aux_task"](model, test_data)
    
    # 4. 约束指标:基本能力检查
    ppl = math.exp(model.loss)
    
    # 5. 假阳性检测
    is_false_positive = main_metric <= random_baseline * 10
    
    return {
        "main_metric": main_metric,
        "random_baseline": random_baseline,
        "aux_metric": aux_metric,
        "PPL": ppl,
        "is_false_positive": is_false_positive,
    }
```

---

## 常见误区

**误区一:只看主指标,不算随机基线**
- 错误想法:主指标高说明模型很强
- 正确做法:先算随机基线,如果随机基线也很高,可能是假阳性

**误区二:辅助指标和主指标用同一份数据**
- 错误想法:两个指标都用同一份测试集
- 正确做法:必须用独立数据集,否则指标重叠导致假阳性

**误区三:随机基线总是很低**
- 错误想法:随机猜测准确率肯定很低
- 正确做法:如果评估函数有bug,随机基线可能=1.0

**误区四:约束指标越低越好**
- 错误想法:PPL=0说明模型完美
- 正确做法:PPL过低说明过拟合,正常范围是10-500

---

## 参考案例(LMT-twister项目)

### 案例一:V22 WRITE冻结指标

| 实验 | pos_decl(主) | set_decl(辅助) | fresh(辅助) | PPL(约束) |
|:-----|:------------:|:--------------:|:-----------:|:---------:|
| C1-baseline | 0.172 | 0.827 | 0.0 | 64 |
| C3-frozen | **0.400** | 0.967 | 28.8 | 232 |

**关键发现**:
- PPL 64的小模型比PPL 760的大模型更好
- 内容新鲜度(fresh)是因果学习的关键

---

### 案例二:V23假阳性指标对比

| 指标 | 结果 | 随机基线 | 判定 |
|:-----|:----:|:--------:|:----:|
| pos_decl_full | 74-87% | — | ✅ 真实 |
| int_basic | 95-99% | ~1% | ⚠️ 假阳性(与pos_decl重叠) |
| chain3 | 87-94% | ~50% | ⚠️ 假阳性(集合论) |
| cf_token | 1.5-1.6% | ~1% | ❌ 真实失败 |

**教训**:int_basic=98%与pos_decl_full重叠,是假阳性。

---

### 案例三:V25.5评估bug修复

| 指标 | 修复前(V25.4) | 修复后(V25.5) | 说明 |
|:-----|:--------------:|:--------------:|:-----|
| random_baseline | 1.000 | 7e-9 | 从"总是对"变为正确的概率 |
| model_metric vs random | FAIL | PASS | 模型确实超越随机 |

**修复逻辑**:
```python
# 修复前（错误）：随机状态几乎总是与真实不同
random_state = torch.randint(0, V, (read_window,))
if (random_state != real_state).sum() > 0:
    random_correct += 1  # → random_baseline = 1.0

# 修复后（正确）：随机猜中所有位置的概率
random_acc = (1.0 / V) ** read_window  # → random_baseline ≈ 7e-9
```

---

### 案例四:V26规则泛化测试

| 规则 | 描述 | 准确率 | 判定 |
|:-----|:-----|:------:|:----:|
| A（标准） | READ返回最后一次WRITE | 94.54% | ✅ 状态跟踪 |
| B（偏移） | READ返回(token+1)%V | 0.00% | ❌ 因果推理失败 |
| C（历史） | READ返回倒数第二次WRITE | 13.03% | ❌ 因果推理失败 |

**教训**:模型是"状态跟踪器"(94.54%),不是"因果推理器"(规则B=0%)。
