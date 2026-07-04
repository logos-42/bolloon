---
name: 消融实验技能-成功标准
description: 消融实验的成功标准——阈值判定、评估流程、综合评估模板。适用于任何需要判断实验是否成功的机器学习/深度学习项目。Use when the user 提到"成功标准"、"成功阈值"、"评估流程"、"判定标准"、"实验是否成功"、"机制是否有效",或想判断消融实验结果是否达到预期。
author: 元木
updated: 2026-06-29
source: original
---

# 成功标准:机制是否真的有效

> **"不是所有指标 > 0都叫成功。"**  
> **成功有明确的阈值:5%是及格线,2%是底线。**  
> **低于随机基线 × 10就是假阳性。**

主 skill [消融实验技能/](../SKILL.md) 讲"总览",本 skill 讲"成功标准"。

---

## 一句话心法

> **指标 > 5%是成功,指标 > 2%是部分成功,指标 ≤ 随机基线 × 10是假阳性。**

---

## 核心内容

### 阈值体系(普适性)

| 阈值 | 判定 | 含义 | 后续行动 |
|:-----|:-----|:-----|:---------|
| 指标 > 5% | ✅ 成功 | 机制有效 | 记录结果,继续下一个实验 |
| 指标 > 2% | ⚠️ 部分成功 | 机制可能有效 | 需要进一步验证 |
| 指标 < 2% | ❌ 失败 | 机制无效 | 分析原因,调整设计 |
| 指标 ≤ 随机基线 × 10 | ❌ 假阳性 | 结果不可信 | 检查评估函数和指标 |

**说明**:
- 5%和2%是经验值,可根据具体项目调整
- 随机基线 × 10是硬性标准,不可调整
- 假阳性检测优先于成功判定

---

### 评估流程

```python
def evaluate_experiment(metric, random_baseline, constraint_metric=None, 
                        constraint_range=(10, 500)):
    """完整的实验评估流程
    
    metric: 主指标值
    random_baseline: 随机基线
    constraint_metric: 约束指标值(如PPL)
    constraint_range: 约束指标合理范围(min, max)
    """
    
    result = {
        "metric": metric,
        "random_baseline": random_baseline,
        "is_false_positive": False,
        "verdict": "",
        "details": [],
    }
    
    # 1. 假阳性检测(最高优先级)
    if metric <= random_baseline * 10:
        result["is_false_positive"] = True
        result["verdict"] = "❌ 假阳性"
        result["details"].append(f"指标={metric:.4f} ≤ 随机基线×10={random_baseline*10:.4f}")
        return result
    
    # 2. 约束指标检查
    if constraint_metric is not None:
        min_val, max_val = constraint_range
        if constraint_metric > max_val:
            result["details"].append(f"⚠️ 约束指标过高({constraint_metric:.2f}),模型可能没学到东西")
        elif constraint_metric < min_val:
            result["details"].append(f"⚠️ 约束指标过低({constraint_metric:.2f}),可能过拟合")
    
    # 3. 成功判定
    if metric > 0.05:
        result["verdict"] = "✅ 成功"
        result["details"].append("指标 > 5%,机制有效")
    elif metric > 0.02:
        result["verdict"] = "⚠️ 部分成功"
        result["details"].append("2% < 指标 < 5%,需要进一步验证")
    else:
        result["verdict"] = "❌ 失败"
        result["details"].append(f"指标={metric:.4f} < 2%,机制无效")
    
    return result

# 示例
result = evaluate_experiment(0.08, 0.00000001, 150)
# {'verdict': '✅ 成功', 'is_false_positive': False, ...}
```

---

### 综合评估模板

```python
def comprehensive_evaluation(config_name, results, random_baseline):
    """综合评估模板:假阳性检测 + 成功判定 + 约束检查"""
    
    metric = results["metric"]
    constraint = results.get("constraint", None)
    
    print(f"\n{'='*60}")
    print(f"实验: {config_name}")
    print(f"{'='*60}")
    
    # 基本信息
    print(f"主指标:      {metric:.6f}")
    print(f"随机基线:    {random_baseline:.10f}")
    print(f"指标/基线:   {metric/random_baseline:.2f}x")
    if constraint is not None:
        print(f"约束指标:    {constraint:.2f}")
    
    # 评估
    evaluation = evaluate_experiment(metric, random_baseline, constraint)
    
    print(f"\n判定: {evaluation['verdict']}")
    for detail in evaluation["details"]:
        print(f"  - {detail}")
    
    print(f"{'='*60}\n")
    
    return evaluation

# 示例
comprehensive_evaluation("C2-仅A", {"metric": 0.15, "constraint": 150}, 0.00000001)
```

---

### 批量评估

```python
def batch_evaluation(results_dict, random_baseline, vocab_size, num_predictions):
    """批量评估多个实验"""
    
    # 重新计算随机基线(确保正确)
    random_baseline_calculated = (1 / vocab_size) ** num_predictions
    if abs(random_baseline_calculated - random_baseline) > 0.001:
        print(f"⚠️ 随机基线不一致:传入={random_baseline:.10f},计算={random_baseline_calculated:.10f}")
    
    evaluations = {}
    success_count = 0
    false_positive_count = 0
    
    for config_name, results in results_dict.items():
        evaluation = comprehensive_evaluation(config_name, results, random_baseline)
        evaluations[config_name] = evaluation
        
        if evaluation["verdict"].startswith("✅"):
            success_count += 1
        if evaluation["is_false_positive"]:
            false_positive_count += 1
    
    # 汇总统计
    print(f"\n{'='*60}")
    print("汇总统计")
    print(f"{'='*60}")
    print(f"总实验数:      {len(results_dict)}")
    print(f"成功实验:      {success_count}")
    print(f"假阳性实验:    {false_positive_count}")
    print(f"成功率:        {success_count/len(results_dict)*100:.1f}%")
    print(f"{'='*60}")
    
    return evaluations
```

---

## 代码示例:实验报告生成

```python
def generate_experiment_report(configs, results, random_baseline, vocab_size, num_predictions):
    """生成完整的实验报告"""
    
    report = []
    report.append("# 消融实验报告\n")
    
    # 实验配置
    report.append("## 实验配置\n")
    report.append(f"- 输出空间大小: {vocab_size}")
    report.append(f"- 预测数量: {num_predictions}")
    report.append(f"- 随机基线: {random_baseline:.10f}\n")
    
    # 结果汇总
    report.append("## 结果汇总\n")
    report.append("| 实验 | 指标 | vs基线 | 约束指标 | 判定 |")
    report.append("|------|------|--------|----------|------|")
    
    baseline_metric = results["C1-baseline"]["metric"]
    for name, data in results.items():
        vs_baseline = data["metric"] - baseline_metric
        evaluation = evaluate_experiment(data["metric"], random_baseline, data.get("constraint"))
        report.append(f"| {name} | {data['metric']:.4f} | {vs_baseline:+.4f} | {data.get('constraint', 'N/A')} | {evaluation['verdict']} |")
    
    report.append("")
    
    # 关键发现
    report.append("## 关键发现\n")
    sorted_results = sorted(results.items(), key=lambda x: x[1]["metric"], reverse=True)
    for name, data in sorted_results[:3]:
        report.append(f"- **{name}**: 指标={data['metric']:.4f}")
    
    return "\n".join(report)
```

---

## 常见误区

**误区一:没有明确的成功标准**
- 错误想法:指标 > 0就算成功
- 正确做法:必须有明确的阈值(5%成功,2%部分成功)

**误区二:忽略假阳性检测**
- 错误想法:指标高就是好
- 正确做法:必须先检测假阳性,否则结果不可信

**误区三:不检查约束指标**
- 错误想法:只要主指标高就行
- 正确做法:约束指标过高说明模型没学到东西,过低说明过拟合

**误区四:不与随机基线比较**
- 错误想法:指标=1%说明模型有效
- 正确做法:必须与随机基线比较,1%可能已经远超随机,也可能没有

**误区五:阈值不可调整**
- 错误想法:5%和2%是固定标准
- 正确做法:阈值可根据具体项目调整,但随机基线×10是硬性标准

---

## 参考案例(LMT-twister项目)

### 案例一:V22 WRITE冻结——成功案例

**实验结果**:
| 实验 | 指标 | 约束指标 | 判定 |
|:-----|:----:|:--------:|:----:|
| C1-baseline | 0.172 | 64 | ❌ 基准(未突破30%) |
| C3-frozen | 0.400 | 232 | ✅ 成功(突破30%阈值) |

**判定逻辑**:
- 指标 17.2% → 40.0% (+22.8%)
- 突破30%"真正学会"阈值
- **结论**:WRITE冻结让陈述性因果首次被学会

---

### 案例二:V23反事实推理——失败案例

**实验结果**:
| 指标 | 结果 | 随机基线 | 判定 |
|:-----|:----:|:--------:|:----:|
| cf_token | 1.5% | ~1% | ❌ 失败(≈随机) |
| cf_shift | 1.5% | ~1% | ❌ 失败(≈随机) |
| int_basic | 98% | ~1% | ⚠️ 假阳性(指标重叠) |

**判定逻辑**:
- 指标 ≈ 随机基线 → 机制无效
- int_basic=98%与pos_decl_full重叠 → 假阳性
- **结论**:反事实推理在252K SSM+GRU架构下失败

---

### 案例三:V25.4评估bug——假阳性案例

**实验结果**:
| 指标 | 修复前 | 修复后 | 说明 |
|:-----|:------:|:------:|:-----|
| 随机基线 | 1.000 | 7e-9 | 评估函数bug |
| 模型指标 | 0.019% | 0.017% | 模型能力不变 |
| 判定 | 失败 | 通过 | 评估框架修正 |

**判定逻辑**:
- 修复前:指标(0.019%) ≤ 随机基线(1.0) × 10 → 假阳性
- 修复后:指标(0.017%) > 随机基线(7e-9) × 10 → 通过
- **结论**:评估框架本身可能有bug,必须先验证

---

### 案例四:V26规则泛化——结构性规律跟踪

**实验结果**:
| 规则 | 描述 | 准确率 | 判定 |
|:-----|:-----|:------:|:----:|
| A（标准） | 标准规则 | 94.54% | ✅ 状态跟踪 |
| B（偏移） | 偏移规则 | 0.00% | ❌ 理解失败 |
| C（历史） | 历史规则 | 13.03% | ❌ 理解失败 |

**判定逻辑**:
- 规则A:94.54% → 模型能跟踪状态
- 规则B:0% → 模型不能适应不同规则
- **结论**:模型是"状态跟踪器",不是"因果推理器"
