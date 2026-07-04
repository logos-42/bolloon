---
name: 消融实验技能-归因分析
description: 消融实验的归因分析——组件贡献量化、汇总表格生成、增量分析方法。适用于任何需要分析组件贡献的机器学习/深度学习项目。Use when the user 提到"归因分析"、"组件贡献"、"增量分析"、"汇总表格"、"实验结果对比"、"哪个组件有效"、"贡献量化",或想分析消融实验中各组件的贡献大小。
author: 元木
updated: 2026-06-29
source: original
---

# 归因分析:哪个组件真正有效

> **"不是加了有效,是拆了才看出缺什么。"**  
> **归因的核心是比较:有这个组件 vs 没有这个组件。**  
> **汇总表格是归因的最终形态。**

主 skill [消融实验技能/](../SKILL.md) 讲"总览",本 skill 讲"归因分析"。

---

## 一句话心法

> **归因 = 增量比较:指标(有组件) - 指标(无组件) = 组件贡献。**

---

## 核心内容

### 归因分析的三种方法(普适性)

| 方法 | 适用场景 | 计算方式 |
|:-----|:---------|:---------|
| **增量分析** | 两个实验对比 | Δ = 指标(C_with) - 指标(C_without) |
| **边际贡献** | 多个组件逐步加入 | Δ = 指标(C_n) - 指标(C_{n-1}) |
| **全量对比** | 所有实验一起看 | 汇总表格,横向比较 |

---

### 方法一:增量分析

**定义**:比较有某组件和没有某组件的指标差异。

```python
def incremental_analysis(metric_with, metric_without, component_name):
    """增量分析:计算组件贡献
    
    metric_with: 有该组件时的指标
    metric_without: 没有该组件时的指标
    component_name: 组件名称
    """
    delta = metric_with - metric_without
    
    if delta > 0.05:
        verdict = "强贡献"
    elif delta > 0.02:
        verdict = "中等贡献"
    elif delta > 0:
        verdict = "弱贡献"
    else:
        verdict = "无贡献或负贡献"
    
    return {
        "component": component_name,
        "metric_with": metric_with,
        "metric_without": metric_without,
        "delta": delta,
        "verdict": verdict,
    }

# 示例:比较C2(仅A)和C1(基准)
result = incremental_analysis(0.15, 0.01, "组件A")
# {'component': '组件A', 'delta': 0.14, 'verdict': '强贡献'}
```

---

### 方法二:边际贡献

**定义**:在已有组件基础上,逐步加入新组件,计算每一步的增量。

```python
def marginal_contribution(results):
    """边际贡献:逐步加入组件的增量
    
    results: 按加入顺序排列的指标值列表
    """
    contributions = []
    
    for i in range(1, len(results)):
        delta = results[i]["metric"] - results[i-1]["metric"]
        contributions.append({
            "step": f"{results[i-1]['name']} → {results[i]['name']}",
            "delta": delta,
            "component": results[i]["name"],
        })
    
    return contributions

# 示例:C1→C2→C4→C8
results = [
    {"name": "C1-baseline", "metric": 0.01},
    {"name": "C2-仅A",     "metric": 0.15},
    {"name": "C4-A+B",     "metric": 0.25},
    {"name": "C8-all",     "metric": 0.32},
]
contributions = marginal_contribution(results)
# C1→C2: +0.14 (组件A)
# C2→C4: +0.10 (组件B)
# C4→C8: +0.07 (其他组件)
```

---

### 方法三:全量对比(汇总表格)

**定义**:将所有实验结果汇总到一张表格,横向比较。

```python
def generate_summary_table(results, random_baseline):
    """生成消融实验汇总表格
    
    results: 字典,键为实验名,值为指标值
    random_baseline: 随机基线
    """
    print(f"{'实验':<20} {'指标':<10} {'vs基线':<10} {'判定':<10}")
    print("-" * 50)
    
    for name, metric in results.items():
        vs_baseline = metric - list(results.values())[0]
        
        # 判定
        if metric > 0.05:
            verdict = "✅成功"
        elif metric > 0.02:
            verdict = "⚠️部分"
        elif metric <= random_baseline * 10:
            verdict = "❌假阳性"
        else:
            verdict = "❌失败"
        
        print(f"{name:<20} {metric:<10.4f} {vs_baseline:<+10.4f} {verdict:<10}")

# 示例
results = {
    "C1-baseline": 0.01,
    "C2-仅A":      0.15,
    "C3-仅B":      0.08,
    "C4-A+B":      0.25,
    "C8-all":      0.32,
}
generate_summary_table(results, random_baseline=0.00000001)
```

**输出示例**:
```
实验                 指标       vs基线     判定
--------------------------------------------------
C1-baseline          0.0100     +0.0000    ❌失败
C2-仅A               0.1500     +0.1400    ✅成功
C3-仅B               0.0800     +0.0700    ✅成功
C4-A+B               0.2500     +0.2400    ✅成功
C8-all               0.3200     +0.3100    ✅成功
```

---

## 代码示例:完整归因分析

```python
def full_attribution_analysis(configs, results, random_baseline):
    """完整的归因分析流程"""
    
    print("=" * 60)
    print("消融实验归因分析")
    print("=" * 60)
    
    # 1. 生成汇总表格
    print("\n📊 汇总表格:")
    generate_summary_table(results, random_baseline)
    
    # 2. 增量分析(与基准比较)
    print("\n📈 增量分析(与C1-baseline比较):")
    baseline_metric = results["C1-baseline"]
    for name, metric in results.items():
        if name != "C1-baseline":
            result = incremental_analysis(metric, baseline_metric, name)
            print(f"   {name}: Δ={result['delta']:+.4f} ({result['verdict']})")
    
    # 3. 识别最强组件
    print("\n🏆 最强组件:")
    sorted_results = sorted(results.items(), key=lambda x: x[1], reverse=True)
    for name, metric in sorted_results[:3]:
        print(f"   {name}: 指标={metric:.4f}")
    
    # 4. 假阳性检测
    print("\n🔍 假阳性检测:")
    for name, metric in results.items():
        if metric <= random_baseline * 10:
            print(f"   ⚠️ {name}: 假阳性! 指标={metric:.4f} ≤ 随机基线×10={random_baseline*10:.4f}")
    
    print("\n" + "=" * 60)
```

---

## 常见误区

**误区一:只看最终结果,不看增量**
- 错误想法:C8-all最高,说明所有组件都有用
- 正确做法:看每一步的增量,可能某些组件贡献很小

**误区二:忽略假阳性**
- 错误想法:指标高就是好
- 正确做法:必须通过假阳性检测,否则结果不可信

**误区三:不与基准比较**
- 错误想法:C2-仅A的指标=15%,说明组件A有效
- 正确做法:必须与C1-baseline比较,计算增量

**误区四:归因到错误的组件**
- 错误想法:C4比C2好,说明组件B有效
- 正确做法:C4和C2的差异可能是组件B,也可能是A+B的交互效应

**误区五:单组件最优=组合最优**
- 错误想法:C3(仅A)最好,说明A是唯一有效组件
- 正确做法:组合时可能有干扰,需要看C4-C8的组合效果

---

## 参考案例(LMT-twister项目)

### 案例一:V22 WRITE冻结归因分析

**实验设计**:6组消融实验,每次改变一个组件

| 操作 | 修法 | 指标变化 | 判定 |
|:-----|:-----|:--------:|:----:|
| C1 → C2 | 大模型 | **-0.005** | ❌ 无效 |
| C1 → C3 | 冻结 | **+0.228** | ⭐ 强贡献 |
| C1 → C4 | 加权 | +0.007 | ❌ 无效 |
| C1 → C5 | 冻结+加权 | +0.182 | ⚠️ 低于C3 |
| C1 → C6 | 全部 | +0.137 | ⚠️ 低于C3 |

**归因结论**:WRITE冻结是唯一有效的修法(+22.8%)。大模型和位置加权都是无效甚至有害的。

**关键洞察**:
- C6-all(全部加上)比C3(只保留冻结)差9.1%
- 单组件最优 ≠ 组合最优

---

### 案例二:V22.1冻结步长归因

**实验设计**:扫描冻结步长(5/10/20步)

| 冻结步长 | 指标 | 新鲜度 | 判定 |
|:--------:|:----:|:------:|:----:|
| 0 (无) | 0.075 | 0.0 | ❌ 基准 |
| **5** | **0.472** | 22.5 | ⭐ 最优 |
| 10 | 0.295 | 25.1 | ⚠️ 过度冻结 |
| 20 | 0.235 | 35.1 | ❌ 完全静态 |

**归因结论**:冻结5步是甜蜜点。冻结太长反而下降。

**关键洞察**:
- 归因必须量化:用增量分析(Δ = 指标(有) - 指标(无))
- 归因必须全面:看所有实验,不能只看最优的

---

### 案例三:V22-V22.1系列全景归因

| 版本 | 创新 | 指标 | 真正有效? | 归因 |
|:-----|:-----|:----:|:---------:|:-----|
| V21 | 集合论评估 | 0.870 (假) | ❌ 假阳性 | 宽松指标 |
| V21.1 | 位置论严格 | 0.174 | ❌ 上限 | 真实上限 |
| V22 | 冻结10步 | 0.400 | ✅ 部分 | 冻结有效 |
| V22.1 | 冻结5步 | 0.472 | ✅ 真实 | 短冻结最优 |

**归因结论**:V20-V22系列的核心突破是WRITE冻结,不是大模型或位置加权。
