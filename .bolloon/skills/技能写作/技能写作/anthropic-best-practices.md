# Skill 编写最佳实践

> 学习如何写出 Claude 能够发现并成功使用的有效 Skill。

好的 Skill 应当简洁、结构清晰，并经过真实使用场景的测试。本指南提供了实用的编写决策，帮助你写出 Claude 容易发现并能有效使用的 Skill。

有关 Skill 工作原理的概念性背景，请参见 [Skills overview](/en/docs/agents-and-tools/agent-skills/overview)。

## 核心原则

### 简洁至上

[Context window](https://platform.claude.com/docs/en/build-with-claude/context-windows) 是一种公共资源。你的 Skill 与 Claude 需要知道的所有其他信息共享同一个 context window，包括：

* 系统提示
* 对话历史
* 其他 Skill 的 metadata
* 你的实际请求

并不是 Skill 里的每个 token 都有即时成本。启动时，只有所有 Skill 的 metadata（name 和 description）会预加载。Claude 只在 Skill 变得相关时才会读 SKILL.md，其他文件也是按需读取。不过，SKILL.md 简洁仍然很重要：一旦 Claude 加载它，里面的每一个 token 都要和对话历史、其它 context 抢位置。

**默认假设**：Claude 本身已经非常聪明

只补充 Claude 没有的信息。对每条信息都要拷问：

* "Claude 真的需要这个解释吗？"
* "Claude 应该已经知道了吧？"
* "这一段值得它占用的 token 吗？"

**好示例：简洁**（约 50 token）：

````markdown  theme={null}
## Extract PDF text

Use pdfplumber for text extraction:

```python
import pdfplumber

with pdfplumber.open("file.pdf") as pdf:
    text = pdf.pages[0].extract_text()
```
````

**坏示例：太啰嗦**（约 150 token）：

```markdown  theme={null}
## Extract PDF text

PDF (Portable Document Format) files are a common file format that contains
text, images, and other content. To extract text from a PDF, you'll need to
use a library. There are many libraries available for PDF processing, but we
recommend pdfplumber because it's easy to use and handles most cases well.
First, you'll need to install it using pip. Then you can use the code below...
```

简洁版本默认 Claude 已经知道 PDF 是什么、库是怎么工作的。

### 设置恰当的自由度

根据任务的脆弱性和变数来匹配具体程度。

**高自由度**（文本式指令）：

适用场景：

* 多种方法都行得通
* 决策取决于上下文
* 由启发式规则来引导方法选择

示例：

```markdown  theme={null}
## Code review process

1. Analyze the code structure and organization
2. Check for potential bugs or edge cases
3. Suggest improvements for readability and maintainability
4. Verify adherence to project conventions
```

**中自由度**（带参数的伪代码或脚本）：

适用场景：

* 存在一个推荐模式
* 允许一定变化
* 配置会影响行为

示例：

````markdown  theme={null}
## Generate report

Use this template and customize as needed:

```python
def generate_report(data, format="markdown", include_charts=True):
    # Process data
    # Generate output in specified format
    # Optionally include visualizations
```
````

**低自由度**（具体脚本，几乎没有参数）：

适用场景：

* 操作脆弱且容易出错
* 一致性至关重要
* 必须严格按特定顺序执行

示例：

````markdown  theme={null}
## Database migration

Run exactly this script:

```bash
python scripts/migrate.py --verify --backup
```

Do not modify the command or add additional flags.
````

**类比：** 把 Claude 想象成在探路的机器人：

* **两侧都是悬崖的窄桥**：只有一条安全通道。给出具体的护栏和精确指令（低自由度）。例子：必须严格按序执行的数据库迁移。
* **没有危险的旷野**：很多条路都能成功。给个大致方向，相信 Claude 会找到最佳路径（高自由度）。例子：上下文决定最佳方案的代码评审。

### 用你打算用的所有模型测试

Skill 是模型的"附加品"，所以效果取决于底层模型。用你打算用的所有模型来测试你的 Skill。

**按模型分别考虑测试：**

* **Claude Haiku**（快速、经济）：Skill 是否给了足够指引？
* **Claude Sonnet**（均衡）：Skill 是否清晰且高效？
* **Claude Opus**（强推理）：Skill 是否避免过度解释？

在 Opus 上完美工作的 Skill，到 Haiku 上可能需要更多细节。如果打算跨模型使用，就让指令在所有模型上都好用。

## Skill 的结构

<Note>
  **YAML Frontmatter**：SKILL.md 的 frontmatter 支持两个字段：

  * `name` - Skill 的人类可读名称（最多 64 字符）
  * `description` - 一行说明 Skill 做什么以及何时使用（最多 1024 字符）

  完整的 Skill 结构细节请参见 [Skills overview](/en/docs/agents-and-tools/agent-skills/overview#skill-structure)。
</Note>

### 命名约定

用一致的命名模式，让 Skill 更容易被引用和讨论。推荐对 Skill 名字使用**动名词形式**（动词 + -ing），因为这能清晰描述 Skill 所提供的活动或能力。

**好的命名示例（动名词形式）：**

* "Processing PDFs"
* "Analyzing spreadsheets"
* "Managing databases"
* "Testing code"
* "Writing documentation"

**可接受的备选：**

* 名词短语："PDF Processing"、"Spreadsheet Analysis"
* 动作导向："Process PDFs"、"Analyze Spreadsheets"

**避免：**

* 含糊的名字："Helper"、"Utils"、"Tools"
* 过于宽泛："Documents"、"Data"、"Files"
* 在同一个 skill 集合里命名风格不一致

一致的命名有这些好处：

* 在文档和对话中方便引用
* 一眼就能看出 Skill 在做什么
* 便于在多个 Skill 中组织和搜索
* 维护一个专业、统一的 skill 库

### 写出有效的 description

`description` 字段让 Skill 能被搜索到，既要写明 Skill 做什么，也要写明什么时候用它。

<Warning>
  **始终用第三人称写**。description 会被注入到系统提示中，人称不一致会导致发现失败。

  * **好：** "Processes Excel files and generates reports"
  * **避免：** "I can help you process Excel files"
  * **避免：** "You can use this to process Excel files"
</Warning>

**写得具体、带上关键词**。既要写 Skill 做什么，也要写明具体的触发条件和上下文。

每个 Skill 有且仅有一个 description 字段。description 对 Skill 选用至关重要：Claude 用它从可能 100+ 的 Skill 里挑出合适的那一个。你的 description 必须给到足够细节，让 Claude 知道什么时候选它，而 SKILL.md 的其余部分负责实现细节。

有效示例：

**PDF Processing skill：**

```yaml  theme={null}
description: Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction.
```

**Excel Analysis skill：**

```yaml  theme={null}
description: Analyze Excel spreadsheets, create pivot tables, generate charts. Use when analyzing Excel files, spreadsheets, tabular data, or .xlsx files.
```

**Git Commit Helper skill：**

```yaml  theme={null}
description: Generate descriptive commit messages by analyzing git diffs. Use when the user asks for help writing commit messages or reviewing staged changes.
```

像下面这样含糊的 description 要避免：

```yaml  theme={null}
description: Helps with documents
```

```yaml  theme={null}
description: Processes data
```

```yaml  theme={null}
description: Does stuff with files
```

### 渐进式披露的模式

SKILL.md 充当概览，按需把 Claude 指向更详细的资料，就像一份入职指南的目录。渐进式披露的工作原理请参见 [How Skills work](/en/docs/agents-and-tools/agent-skills/overview#how-skills-work)。

**实用指引：**

* SKILL.md 正文保持在 500 行以内，以获得最佳性能
* 接近这个上限时把内容拆到独立文件中
* 借助下面的模式来有效组织指令、代码和资源

#### 可视化总览：从简单到复杂

一个最基础的 Skill 只有一个 SKILL.md，包含 metadata 和指令：

<img src="https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-simple-file.png?fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=87782ff239b297d9a9e8e1b72ed72db9" alt="Simple SKILL.md file showing YAML frontmatter and markdown body" data-og-width="2048" width="2048" data-og-height="1153" height="1153" data-path="images/agent-skills-simple-file.png" data-optimize="true" data-opv="3" srcset="https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-simple-file.png?w=280&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=c61cc33b6f5855809907f7fda94cd80e 280w, https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-simple-file.png?w=560&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=90d2c0c1c76b36e8d485f49e0810dbfd 560w, https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-simple-file.png?w=840&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=ad17d231ac7b0bea7e5b4d58fb4aeabb 840w, https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-simple-file.png?w=1100&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=f5d0a7a3c668435bb0aee9a3a8f8c329 1100w, https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-simple-file.png?w=1650&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=0e927c1af9de5799cfe557d12249f6e6 1650w, https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-simple-file.png?w=2500&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=46bbb1a51dd4c8202a470ac8c80a893d 2500w" />

当你的 Skill 增长时，可以捆绑额外内容，Claude 只在需要时才加载：

<img src="https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-bundling-content.png?fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=a5e0aa41e3d53985a7e3e43668a33ea3" alt="Bundling additional reference files like reference.md and forms.md." data-og-width="2048" width="2048" data-og-height="1327" height="1327" data-path="images/agent-skills-bundling-content.png" data-optimize="true" data-opv="3" srcset="https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-bundling-content.png?w=280&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=f8a0e73783e99b4a643d79eac86b70a2 280w, https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-bundling-content.png?w=560&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=dc510a2a9d3f14359416b706f067904a 560w, https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-bundling-content.png?w=840&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=82cd6286c966303f7dd914c28170e385 840w, https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-bundling-content.png?w=1100&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=56f3be36c77e4fe4b523df209a6824c6 1100w, https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-bundling-content.png?w=1650&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=d22b5161b2075656417d56f41a74f3dd 1650w, https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-bundling-content.png?w=2500&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=3dd4bdd6850ffcc96c6c45fcb0acd6eb 2500w" />

一个完整的 Skill 目录结构大致如下：

```
pdf/
├── SKILL.md              # 主要指令（触发时加载）
├── FORMS.md              # 表单填写指南（按需加载）
├── reference.md          # API 参考（按需加载）
├── examples.md           # 使用示例（按需加载）
└── scripts/
    ├── analyze_form.py   # 工具脚本（执行而不加载）
    ├── fill_form.py      # 表单填写脚本
    └── validate.py       # 验证脚本
```

#### 模式 1：高层指南 + 引用

````markdown  theme={null}
---
name: PDF Processing
description: Extracts text and tables from PDF files, fills forms, and merges documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction.
---

# PDF Processing

## Quick start

Extract text with pdfplumber:
```python
import pdfplumber
with pdfplumber.open("file.pdf") as pdf:
    text = pdf.pages[0].extract_text()
```

## Advanced features

**Form filling**: See [FORMS.md](FORMS.md) for complete guide
**API reference**: See [REFERENCE.md](REFERENCE.md) for all methods
**Examples**: See [EXAMPLES.md](EXAMPLES.md) for common patterns
````

Claude 只在需要时才加载 FORMS.md、REFERENCE.md 或 EXAMPLES.md。

#### 模式 2：按领域组织

一个 Skill 涉及多个领域时，按领域组织内容，避免加载无关的 context。用户问销售指标时，Claude 只需要读销售相关的 schema，不需要看财务或市场数据。这样能保持低 token 消耗、聚焦的 context。

```
bigquery-skill/
├── SKILL.md (overview and navigation)
└── reference/
    ├── finance.md (revenue, billing metrics)
    ├── sales.md (opportunities, pipeline)
    ├── product.md (API usage, features)
    └── marketing.md (campaigns, attribution)
```

````markdown SKILL.md theme={null}
# BigQuery Data Analysis

## Available datasets

**Finance**: Revenue, ARR, billing → See [reference/finance.md](reference/finance.md)
**Sales**: Opportunities, pipeline, accounts → See [reference/sales.md](reference/sales.md)
**Product**: API usage, features, adoption → See [reference/product.md](reference/product.md)
**Marketing**: Campaigns, attribution, email → See [reference/marketing.md](reference/marketing.md)

## Quick search

Find specific metrics using grep:

```bash
grep -i "revenue" reference/finance.md
grep -i "pipeline" reference/sales.md
grep -i "api usage" reference/product.md
```
````

#### 模式 3：按条件展开细节

先展示基础内容，再链接到进阶内容：

```markdown  theme={null}
# DOCX Processing

## Creating documents

Use docx-js for new documents. See [DOCX-JS.md](DOCX-JS.md).

## Editing documents

For simple edits, modify the XML directly.

**For tracked changes**: See [REDLINING.md](REDLINING.md)
**For OOXML details**: See [OOXML.md](OOXML.md)
```

Claude 只在用户需要这些功能时才读 REDLINING.md 或 OOXML.md。

### 避免深嵌套的引用

当文件被嵌套引用的文件再引用时，Claude 可能会"部分读取"。遇到嵌套引用时，Claude 可能用 `head -100` 之类的命令去预览，而不是读完整文件，结果就拿不到完整信息。

**保持引用从 SKILL.md 出发只有一层深度**。所有参考文件都应直接从 SKILL.md 链接，确保 Claude 在需要时能读到完整文件。

**坏示例：嵌套太深：**

```markdown  theme={null}
# SKILL.md
See [advanced.md](advanced.md)...

# advanced.md
See [details.md](details.md)...

# details.md
Here's the actual information...
```

**好示例：只嵌套一层：**

```markdown  theme={null}
# SKILL.md

**Basic usage**: [instructions in SKILL.md]
**Advanced features**: See [advanced.md](advanced.md)
**API reference**: See [reference.md](reference.md)
**Examples**: See [examples.md](examples.md)
```

### 给较长的参考文件加上目录

超过 100 行的参考文件，应该在顶部加一个目录。这样即使 Claude 只是部分预览，也能看到可用信息的全貌。

**示例：**

```markdown  theme={null}
# API Reference

## Contents
- Authentication and setup
- Core methods (create, read, update, delete)
- Advanced features (batch operations, webhooks)
- Error handling patterns
- Code examples

## Authentication and setup
...

## Core methods
...
```

Claude 既可以读完整文件，也可以按需跳到具体小节。

关于这种基于文件系统的架构如何支持渐进式披露的细节，请参见下文进阶一节的 [Runtime environment](#runtime-environment)。

## 工作流与反馈循环

### 用工作流处理复杂任务

把复杂操作拆成清晰、连续的步骤。对于特别复杂的工作流，提供一个清单，让 Claude 可以复制到自己的回复里，并随着推进打勾。

**示例 1：研究综合工作流**（用于不带代码的 Skill）：

````markdown  theme={null}
## Research synthesis workflow

Copy this checklist and track your progress:

```
Research Progress:
- [ ] Step 1: Read all source documents
- [ ] Step 2: Identify key themes
- [ ] Step 3: Cross-reference claims
- [ ] Step 4: Create structured summary
- [ ] Step 5: Verify citations
```

**Step 1: Read all source documents**

Review each document in the `sources/` directory. Note the main arguments and supporting evidence.

**Step 2: Identify key themes**

Look for patterns across sources. What themes appear repeatedly? Where do sources agree or disagree?

**Step 3: Cross-reference claims**

For each major claim, verify it appears in the source material. Note which source supports each point.

**Step 4: Create structured summary**

Organize findings by theme. Include:
- Main claim
- Supporting evidence from sources
- Conflicting viewpoints (if any)

**Step 5: Verify citations**

Check that every claim references the correct source document. If citations are incomplete, return to Step 3.
````

这个示例展示了工作流如何应用到不需要代码的分析任务上。清单模式适用于任何复杂的多步流程。

**示例 2：PDF 表单填写工作流**（用于带代码的 Skill）：

````markdown  theme={null}
## PDF form filling workflow

Copy this checklist and check off items as you complete them:

```
Task Progress:
- [ ] Step 1: Analyze the form (run analyze_form.py)
- [ ] Step 2: Create field mapping (edit fields.json)
- [ ] Step 3: Validate mapping (run validate_fields.py)
- [ ] Step 4: Fill the form (run fill_form.py)
- [ ] Step 5: Verify output (run verify_output.py)
```

**Step 1: Analyze the form**

Run: `python scripts/analyze_form.py input.pdf`

This extracts form fields and their locations, saving to `fields.json`.

**Step 2: Create field mapping**

Edit `fields.json` to add values for each field.

**Step 3: Validate mapping**

Run: `python scripts/validate_fields.py fields.json`

Fix any validation errors before continuing.

**Step 4: Fill the form**

Run: `python scripts/fill_form.py input.pdf fields.json output.pdf`

**Step 5: Verify output**

Run: `python scripts/verify_output.py output.pdf`

If verification fails, return to Step 2.
````

清晰的步骤能避免 Claude 跳过关键校验。清单既能帮 Claude 也能帮你跟踪多步工作流的进展。

### 实现反馈循环

**常见模式**：跑校验器 → 修错误 → 重复

这种模式能大幅提升输出质量。

**示例 1：风格指南合规**（用于不带代码的 Skill）：

```markdown  theme={null}
## Content review process

1. Draft your content following the guidelines in STYLE_GUIDE.md
2. Review against the checklist:
   - Check terminology consistency
   - Verify examples follow the standard format
   - Confirm all required sections are present
3. If issues found:
   - Note each issue with specific section reference
   - Revise the content
   - Review the checklist again
4. Only proceed when all requirements are met
5. Finalize and save the document
```

这展示了用参考文档（而非脚本）做校验循环的写法。"校验器"就是 STYLE\_GUIDE.md，Claude 通过读取和对比来完成检查。

**示例 2：文档编辑流程**（用于带代码的 Skill）：

```markdown  theme={null}
## Document editing process

1. Make your edits to `word/document.xml`
2. **Validate immediately**: `python ooxml/scripts/validate.py unpacked_dir/`
3. If validation fails:
   - Review the error message carefully
   - Fix the issues in the XML
   - Run validation again
4. **Only proceed when validation passes**
5. Rebuild: `python ooxml/scripts/pack.py unpacked_dir/ output.docx`
6. Test the output document
```

校验循环能尽早抓住错误。

## 内容编写指引

### 避免时效性信息

不要写入将来会过时的信息：

**坏示例：带时效性**（会变成错的）：

```markdown  theme={null}
If you're doing this before August 2025, use the old API.
After August 2025, use the new API.
```

**好示例**（使用 "old patterns" 一节）：

```markdown  theme={null}
## Current method

Use the v2 API endpoint: `api.example.com/v2/messages`

## Old patterns

<details>
<summary>Legacy v1 API (deprecated 2025-08)</summary>

The v1 API used: `api.example.com/v1/messages`

This endpoint is no longer supported.
</details>
```

"old patterns" 一节提供历史背景，又不让主内容变得臃肿。

### 保持术语一致

选一个词，在整个 Skill 中一直用：

**好 —— 一致：**

* 一直用 "API endpoint"
* 一直用 "field"
* 一直用 "extract"

**坏 —— 不一致：**

* 混用 "API endpoint"、"URL"、"API route"、"path"
* 混用 "field"、"box"、"element"、"control"
* 混用 "extract"、"pull"、"get"、"retrieve"

一致性有助于 Claude 理解和遵循指令。

## 常见模式

### 模板模式

为输出格式提供模板。严格程度根据需要来定。

**严格的要求**（比如 API 响应或数据格式）：

````markdown  theme={null}
## Report structure

ALWAYS use this exact template structure:

```markdown
# [Analysis Title]

## Executive summary
[One-paragraph overview of key findings]

## Key findings
- Finding 1 with supporting data
- Finding 2 with supporting data
- Finding 3 with supporting data

## Recommendations
1. Specific actionable recommendation
2. Specific actionable recommendation
```
````

**灵活的指引**（当允许调整时）：

````markdown  theme={null}
## Report structure

Here is a sensible default format, but use your best judgment based on the analysis:

```markdown
# [Analysis Title]

## Executive summary
[Overview]

## Key findings
[Adapt sections based on what you discover]

## Recommendations
[Tailor to the specific context]
```

Adjust sections as needed for the specific analysis type.
````

### 示例模式

对于那些"看了示例才知道怎么写"的 Skill，像常规 prompting 一样给出 input/output 对：

````markdown  theme={null}
## Commit message format

Generate commit messages following these examples:

**Example 1:**
Input: Added user authentication with JWT tokens
Output:
```
feat(auth): implement JWT-based authentication

Add login endpoint and token validation middleware
```

**Example 2:**
Input: Fixed bug where dates displayed incorrectly in reports
Output:
```
fix(reports): correct date formatting in timezone conversion

Use UTC timestamps consistently across report generation
```

**Example 3:**
Input: Updated dependencies and refactored error handling
Output:
```
chore: update dependencies and refactor error handling

- Upgrade lodash to 4.17.21
- Standardize error response format across endpoints
```

Follow this style: type(scope): brief description, then detailed explanation.
````

示例能比纯描述更清晰地传达想要的风格和详细程度。

### 条件式工作流模式

引导 Claude 走过分支决策点：

```markdown  theme={null}
## Document modification workflow

1. Determine the modification type:

   **Creating new content?** → Follow "Creation workflow" below
   **Editing existing content?** → Follow "Editing workflow" below

2. Creation workflow:
   - Use docx-js library
   - Build document from scratch
   - Export to .docx format

3. Editing workflow:
   - Unpack existing document
   - Modify XML directly
   - Validate after each change
   - Repack when complete
```

<Tip>
  如果工作流变得很大很复杂、步骤很多，考虑把它们推到独立文件里，并告诉 Claude 根据具体任务读取对应文件。
</Tip>

## 评估与迭代

### 先写评估

**在写大段文档之前，先做评估。** 这能保证你的 Skill 在解决真问题，而不是在给假想问题做文档。

**评估驱动的开发：**

1. **找出空白**：在没有 Skill 的情况下，让 Claude 跑代表性任务。记录下具体的失败或缺失的 context。
2. **编写评估**：构造 3 个场景，专门测这些空白。
3. **建立基线**：在没有 Skill 的情况下，量出 Claude 的表现基线。
4. **写最小指令**：只写刚好够解决这些空白、能通过评估的内容。
5. **迭代**：执行评估，与基线对比，再打磨。

这条路能保证你解决的是真问题，而不是在预测可能永远不会出现的需求。

**评估结构：**

```json  theme={null}
{
  "skills": ["pdf-processing"],
  "query": "Extract all text from this PDF file and save it to output.txt",
  "files": ["test-files/document.pdf"],
  "expected_behavior": [
    "Successfully reads the PDF file using an appropriate PDF processing library or command-line tool",
    "Extracts text content from all pages in the document without missing any pages",
    "Saves the extracted text to a file named output.txt in a clear, readable format"
  ]
}
```

<Note>
  这个示例展示了一种数据驱动的评估，附带简单的评分标准。我们目前没有提供内置方式去跑这些评估。用户可以自己搭一套评估系统。评估是衡量 Skill 效果的唯一依据。
</Note>

### 与 Claude 一起迭代式地开发 Skill

最高效的 Skill 开发过程离不开 Claude 本身。让一个 Claude 实例（"Claude A"）来创建 Skill，再让其他实例（"Claude B"）去用它。Claude A 帮你设计、打磨指令，Claude B 在真实任务里测试它。这样能行得通，是因为 Claude 模型既懂得怎么写有效的 agent 指令，也懂得 agent 真正需要什么信息。

**创建一个新 Skill：**

1. **在没有 Skill 的情况下完成一个任务**：用普通 prompting 跟 Claude A 一起把问题做一遍。在这个过程中，你自然会补充 context、解释偏好、分享过程性知识。注意一下你都反复提供了什么信息。

2. **找出可复用的模式**：任务完成后，整理出你提供的、可能对类似未来任务也有用的 context。

   **示例**：如果你做了一次 BigQuery 分析，你可能提供了表名、字段定义、过滤规则（比如"总要把测试账号排除掉"），以及常用查询模式。

3. **让 Claude A 创建 Skill**："Create a Skill that captures this BigQuery analysis pattern we just used. Include the table schemas, naming conventions, and the rule about filtering test accounts."

   <Tip>
     Claude 模型天然理解 Skill 的格式和结构。你不需要专门的系统提示或"writing skills" skill 才能让 Claude 帮你创建 Skill。只要直接让 Claude 创建 Skill，它就会生成结构正确的 SKILL.md，含合适的 frontmatter 和正文。
   </Tip>

4. **检查简洁性**：确认 Claude A 没有塞进多余的解释。可以问："Remove the explanation about what win rate means - Claude already knows that."

5. **改进信息架构**：让 Claude A 把内容组织得更高效。例如："Organize this so the table schema is in a separate reference file. We might add more tables later."

6. **在类似任务上测试**：让 Claude B（一个加载了 Skill 的新实例）去做相关用例。观察 Claude B 能否找到正确信息、正确应用规则、顺利完成。

7. **基于观察迭代**：如果 Claude B 卡住或漏了什么，带着具体观察回到 Claude A："When Claude used this Skill, it forgot to filter by date for Q4. Should we add a section about date filtering patterns?"

**迭代已有的 Skill：**

改进 Skill 时仍然沿用这种分层模式。你在以下三者之间交替：

* **跟 Claude A 协作**（帮 Skill 精修的专家）
* **让 Claude B 测试**（使用 Skill 干活的 agent）
* **观察 Claude B 的行为**，把洞察带回给 Claude A

1. **在真实工作流里用 Skill**：给 Claude B（已加载 Skill）真实任务，而不是测试场景

2. **观察 Claude B 的行为**：记下它卡在哪里、做对了哪些、做出了哪些你没预料到的选择

   **观察示例**："When I asked Claude B for a regional sales report, it wrote the query but forgot to filter out test accounts, even though the Skill mentions this rule."

3. **回到 Claude A 改进**：把当前的 SKILL.md 给它，描述你观察到的现象。可以问："I noticed Claude B forgot to filter test accounts when I asked for a regional report. The Skill mentions filtering, but maybe it's not prominent enough?"

4. **审 Claude A 的建议**：Claude A 可能会建议把规则放得更显眼，把"always filter"换成更强的"MUST filter"，或者重写工作流那一节。

5. **应用并测试改动**：用 Claude A 的精修更新 Skill，再让 Claude B 在类似请求上测试

6. **根据使用情况重复**：遇到新场景时继续这个"观察-精修-测试"循环。每一次迭代都基于 agent 的真实行为而不是假设来改进 Skill。

**收集团队反馈：**

1. 把 Skill 分享给队友，观察他们的使用
2. 问：Skill 是否在预期时机被激活？指令是否清晰？缺了什么？
3. 把反馈纳入进来，弥补你自身使用模式中的盲点

**为什么这条路有效**：Claude A 理解 agent 的需求，你提供领域专业知识，Claude B 通过真实使用暴露空白，而迭代式的精修让 Skill 不断基于真实行为改进，而不是基于假设。

### 观察 Claude 怎么浏览 Skill

迭代 Skill 时，要留意 Claude 在实际中怎么用它。关注：

* **出乎意料的探索路径**：Claude 是不是按你没预料到的顺序读文件？这可能说明你的结构没你想的那么直观。
* **漏掉的关联**：Claude 有没有没跟着链接读到重要文件？你的链接可能要更显眼或更明确。
* **对某些小节过度依赖**：如果 Claude 反复读同一个文件，考虑是不是该把那部分内容放到主 SKILL.md 里。
* **被忽略的内容**：如果 Claude 从来不读某个捆绑进来的文件，它可能是不必要的，或者在主文档里信号不够明显。

基于这些观察去迭代，而不是凭假设。Skill metadata 里的 `name` 和 `description` 尤其关键——Claude 用它们来判断当前任务该不该激活这个 Skill。要确保它们清楚地写明 Skill 做什么以及什么时候该用。

## 要避免的反模式

### 避免 Windows 风格的路径

文件路径里始终用正斜杠，哪怕是在 Windows 上：

* ✓ **好**：`scripts/helper.py`、`reference/guide.md`
* ✗ **避免**：`scripts\helper.py`、`reference\guide.md`

Unix 风格路径跨平台通用，Windows 风格路径在 Unix 上会出错。

### 避免给出太多选择

除非必要，不要罗列多种方案：

````markdown  theme={null}
**Bad example: Too many choices** (confusing):
"You can use pypdf, or pdfplumber, or PyMuPDF, or pdf2image, or..."

**Good example: Provide a default** (with escape hatch):
"Use pdfplumber for text extraction:
```python
import pdfplumber
```

For scanned PDFs requiring OCR, use pdf2image with pytesseract instead."
````

## 进阶：带可执行代码的 Skill

下面几节聚焦在带可执行脚本的 Skill 上。如果你的 Skill 只用 markdown 指令，可以直接跳到 [Checklist for effective Skills](#checklist-for-effective-skills)。

### 自己解决，别踢皮球

为 Skill 写脚本时，自己处理错误条件，不要把锅甩给 Claude。

**好示例：明确处理错误：**

```python  theme={null}
def process_file(path):
    """Process a file, creating it if it doesn't exist."""
    try:
        with open(path) as f:
            return f.read()
    except FileNotFoundError:
        # Create file with default content instead of failing
        print(f"File {path} not found, creating default")
        with open(path, 'w') as f:
            f.write('')
        return ''
    except PermissionError:
        # Provide alternative instead of failing
        print(f"Cannot access {path}, using default")
        return ''
```

**坏示例：把球踢给 Claude：**

```python  theme={null}
def process_file(path):
    # Just fail and let Claude figure it out
    return open(path).read()
```

配置参数也应当有依据并写明注释，避免"巫毒常量"（Ousterhout's law）。如果你都不知道合理的值是多少，Claude 又怎么会知道？

**好示例：自解释：**

```python  theme={null}
# HTTP requests typically complete within 30 seconds
# Longer timeout accounts for slow connections
REQUEST_TIMEOUT = 30

# Three retries balances reliability vs speed
# Most intermittent failures resolve by the second retry
MAX_RETRIES = 3
```

**坏示例：魔法数字：**

```python  theme={null}
TIMEOUT = 47  # Why 47?
RETRIES = 5   # Why 5?
```

### 提供工具脚本

即使 Claude 能写脚本，预制的脚本也有优势：

**工具脚本的好处：**

* 比现场生成的代码更可靠
* 节省 token（不用把代码塞进 context）
* 节省时间（无需生成代码）
* 保证跨使用的一致性

<img src="https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-executable-scripts.png?fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=4bbc45f2c2e0bee9f2f0d5da669bad00" alt="Bundling executable scripts alongside instruction files" data-og-width="2048" width="2048" data-og-height="1154" height="1154" data-path="images/agent-skills-executable-scripts.png" data-optimize="true" data-opv="3" srcset="https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-executable-scripts.png?w=280&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=9a04e6535a8467bfeea492e517de389f 280w, https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-executable-scripts.png?w=560&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=e49333ad90141af17c0d7651cca7216b 560w, https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-executable-scripts.png?w=840&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=954265a5df52223d6572b6214168c428 840w, https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-executable-scripts.png?w=1100&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=2ff7a2d8f2a83ee8af132b29f10150fd 1100w, https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-executable-scripts.png?w=1650&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=48ab96245e04077f4d15e9170e081cfb 1650w, https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-executable-scripts.png?w=2500&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=0301a6c8b3ee879497cc5b5483177c90 2500w" />

上图展示了可执行脚本和指令文件如何协作。指令文件（forms.md）引用脚本，Claude 可以直接执行，而不必把脚本内容加载到 context 里。

**重要区分**：在你的指令里要明确写清，Claude 应当：

* **执行脚本**（最常见）："Run `analyze_form.py` to extract fields"
* **当作参考来读**（处理复杂逻辑时）："See `analyze_form.py` for the field extraction algorithm"

大多数工具脚本首选"执行"，因为更可靠也更高效。脚本执行机制请见下文的 [Runtime environment](#runtime-environment)。

**示例：**

````markdown  theme={null}
## Utility scripts

**analyze_form.py**: Extract all form fields from PDF

```bash
python scripts/analyze_form.py input.pdf > fields.json
```

Output format:
```json
{
  "field_name": {"type": "text", "x": 100, "y": 200},
  "signature": {"type": "sig", "x": 150, "y": 500}
}
```

**validate_boxes.py**: Check for overlapping bounding boxes

```bash
python scripts/validate_boxes.py fields.json
# Returns: "OK" or lists conflicts
```

**fill_form.py**: Apply field values to PDF

```bash
python scripts/fill_form.py input.pdf fields.json output.pdf
```
````

### 用视觉分析

当输入能渲染成图像时，让 Claude 来分析它们：

````markdown  theme={null}
## Form layout analysis

1. Convert PDF to images:
   ```bash
   python scripts/pdf_to_images.py form.pdf
   ```

2. Analyze each page image to identify form fields
3. Claude can see field locations and types visually
````

<Note>
  在这个示例里，你得自己写一个 `pdf_to_images.py` 脚本。
</Note>

Claude 的视觉能力有助于理解版式和结构。

### 创建可校验的中间产物

当 Claude 处理复杂、开放式的任务时，它可能出错。"plan-validate-execute" 模式能让 Claude 先把计划写成结构化格式，再用脚本校验，最后再执行，从而尽早抓出错。

**示例**：想象让 Claude 根据一份电子表格更新 PDF 里的 50 个表单字段。没有校验的话，Claude 可能引用了不存在的字段、写出冲突的值、漏掉必填字段，或者应用更新时出错。

**解决方案**：用上面那个工作流模式（PDF 表单填写），再加一个中间的 `changes.json` 文件，在应用变更前先校验。流程变成：analyze → **create plan file** → **validate plan** → execute → verify。

**这个模式为什么有效：**

* **尽早抓错**：校验在改动生效前就发现问题
* **机器可校验**：脚本给出客观验证
* **可逆的计划**：Claude 可以在不动原始文件的前提下反复打磨计划
* **调试清晰**：错误信息直接指向具体问题

**何时使用**：批量操作、破坏性变更、复杂校验规则、高风险操作。

**实现技巧**：把校验脚本的错误信息写得更具体些，比如 "Field 'signature\_date' not found. Available fields: customer\_name, order\_total, signature\_date\_signed"，方便 Claude 定位问题。

### 包的依赖

Skill 在代码执行环境里跑，存在平台相关的限制：

* **claude.ai**：可以从 npm 和 PyPI 安装包，也能从 GitHub 仓库拉取
* **Anthropic API**：没有网络访问，也没有运行时包安装

在 SKILL.md 里列出所需包，并对照 [code execution tool documentation](/en/docs/agents-and-tools/tool-use/code-execution-tool) 确认它们可用。

### 运行时环境

Skill 在代码执行环境里跑，有文件系统访问、bash 命令和代码执行能力。关于这种架构的概念解释，请参见概览里的 [The Skills architecture](/en/docs/agents-and-tools/agent-skills/overview#the-skills-architecture)。

**这对你的编写有何影响：**

**Claude 怎么访问 Skill：**

1. **Metadata 预加载**：启动时，所有 Skill 的 YAML frontmatter 里的 name 和 description 会被加载到系统提示中
2. **文件按需读取**：Claude 用 bash 读工具按需从文件系统读 SKILL.md 和其他文件
3. **脚本高效执行**：工具脚本可以由 bash 执行，而不必把全部内容加载到 context。只有脚本的输出会消耗 token
4. **大文件无 context 代价**：参考文件、数据、文档在被实际读取之前不消耗 context token

* **文件路径很重要**：Claude 像浏览文件系统一样浏览你的 skill 目录。用正斜杠（`reference/guide.md`），不要用反斜杠
* **给文件起有意义的名字**：用能体现内容的名字，比如 `form_validation_rules.md`，不要用 `doc2.md`
* **组织得便于发现**：按领域或功能组织目录
  * 好：`reference/finance.md`、`reference/sales.md`
  * 坏：`docs/file1.md`、`docs/file2.md`
* **捆绑完整的资源**：可以放完整 API 文档、丰富的示例、海量数据集；在被读取之前没有 context 代价
* **确定性操作优先用脚本**：写一个 `validate_form.py`，比让 Claude 生成校验代码更靠谱
* **明确表达执行意图**：
  * "Run `analyze_form.py` to extract fields"（执行）
  * "See `analyze_form.py` for the extraction algorithm"（当参考读）
* **测试文件访问模式**：用真实请求验证 Claude 能否按你的目录结构正确跳转

**示例：**

```
bigquery-skill/
├── SKILL.md (overview, points to reference files)
└── reference/
    ├── finance.md (revenue metrics)
    ├── sales.md (pipeline data)
    └── product.md (usage analytics)
```

当用户问到 revenue 时，Claude 读 SKILL.md，看到对 `reference/finance.md` 的引用，再调用 bash 精确读这个文件。sales.md 和 product.md 留在文件系统上，不消耗任何 context token，直到需要为止。正是这种基于文件系统的模式让渐进式披露成为可能。Claude 能精确地为每个任务导航、选择性地加载真正需要的内容。

完整的技术架构细节请参见 [How Skills work](/en/docs/agents-and-tools/agent-skills/overview#how-skills-work)。

### MCP 工具引用

如果你的 Skill 使用 MCP（Model Context Protocol）工具，要始终用全限定名，避免 "tool not found" 错误。

**格式**：`ServerName:tool_name`

**示例：**

```markdown  theme={null}
Use the BigQuery:bigquery_schema tool to retrieve table schemas.
Use the GitHub:create_issue tool to create issues.
```

其中：

* `BigQuery` 和 `GitHub` 是 MCP server 名
* `bigquery_schema` 和 `create_issue` 是对应 server 里的工具名

没有 server 前缀时，Claude 可能找不到工具，尤其是在有多个 MCP server 同时可用的情况下。

### 不要假设工具已经装好

不要默认包已经存在：

````markdown  theme={null}
**Bad example: Assumes installation**:
"Use the pdf library to process the file."

**Good example: Explicit about dependencies**:
"Install required package: `pip install pypdf`

Then use it:
```python
from pypdf import PdfReader
reader = PdfReader("file.pdf")
```"
````

## 技术说明

### YAML frontmatter 的要求

SKILL.md 的 frontmatter 只包含 `name`（最多 64 字符）和 `description`（最多 1024 字符）两个字段。完整结构请参见 [Skills overview](/en/docs/agents-and-tools/agent-skills/overview#skill-structure)。

### Token 预算

SKILL.md 正文保持在 500 行以内以获得最佳性能。如果内容超过这个限制，请按前文渐进式披露的模式拆到独立文件。架构细节请参见 [Skills overview](/en/docs/agents-and-tools/agent-skills/overview#how-skills-work)。

## 有效 Skill 的检查清单

在分享 Skill 之前，逐项核对：

### 核心质量

* [ ] description 具体且包含关键词
* [ ] description 既写了 Skill 做什么，也写了什么时候用
* [ ] SKILL.md 正文在 500 行以内
* [ ] 额外的细节放在独立文件里（如有需要）
* [ ] 没有时效性信息（或放在 "old patterns" 一节）
* [ ] 全文术语一致
* [ ] 示例具体而不抽象
* [ ] 文件引用嵌套深度为一层
* [ ] 恰当地使用了渐进式披露
* [ ] 工作流步骤清晰

### 代码与脚本

* [ ] 脚本自己解决问题，不把锅甩给 Claude
* [ ] 错误处理明确且有用
* [ ] 没有"巫毒常量"（所有值都有依据）
* [ ] 在指令中列出所需包，并确认可用
* [ ] 脚本有清晰的文档
* [ ] 没有 Windows 风格路径（统一用正斜杠）
* [ ] 关键操作有校验/验证步骤
* [ ] 质量关键的任务包含反馈循环

### 测试

* [ ] 至少有 3 个评估
* [ ] 在 Haiku、Sonnet、Opus 上分别测过
* [ ] 用真实使用场景测试过
* [ ] 收集团队反馈并整合（如适用）

## 下一步

<CardGroup cols={2}>
  <Card title="Get started with Agent Skills" icon="rocket" href="/en/docs/agents-and-tools/agent-skills/quickstart">
    Create your first Skill
  </Card>

  <Card title="Use Skills in Claude Code" icon="terminal" href="/en/docs/claude-code/skills">
    Create and manage Skills in Claude Code
  </Card>

  <Card title="Use Skills with the API" icon="code" href="/en/api/skills-guide">
    Upload and use Skills programmatically
  </Card>
</CardGroup>
