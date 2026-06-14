<!-- tool.manifest@1.0.0 -->
# 工具清单 (变薄版 — 详细 schema 搬到代码侧)

**16 个工具的详细定义在 `src/llm/tool-manifest/` (1 文件 1 工具), 调用时由 PiAI 客户端解析. 此处只列名字 + 一句话 + 调用格式.**

## 调用格式 (金脱除后)

```text
[TOOL:func_name]
[P:arg_name]value[/P]
...
[ENDTOOL]
```

字符串和标量参数应按原样指定, 而列表和对象应使用 JSON 格式.

## 工具列表 (按用途分组)

### 用户交互
- **ask_user_input_v0** — 在提供建议前展示可点击的选项以收集用户偏好 (1-3 个问题, 每问 2-4 选项). 用于引出信息.
- **message_compose_v1** — 起草目标导向的消息 (email / textMessage / other). 高风险沟通生成 2-3 种策略.

### 文件与代码
- **bash_tool** — 在容器中运行 bash 命令. 必须用 description 参数说明.
- **create_file** — 在容器中创建新文件 (路径已存在则失败).
- **str_replace** — 精确替换文件中唯一字符串 (old_str 必须唯一).
- **view** — 读取文本/图像/目录 (目录最多 2 层深度).

### 文档创建 (Artifacts)
- **present_files** — 让文件对用户可见 (放 /mnt/user-data/outputs).
- **recipe_display_v0** — 显示带可调整份量的交互式食谱.
- **recommend_bolloon_apps** — 推荐 1-3 个 Bolloon 应用 (desktop/ios/excel 等).

### 搜索
- **image_search** — 在 Web 上查找图像 (3-4 张/次). 视觉内容时用.
- **web_search** — 搜索 Web (前 10 条). 当前信息时用.
- **web_fetch** — 获取指定 URL 网页内容. URL 必须含协议.
- **weather_fetch** — 显示天气 (按用户位置确定温度单位).
- **places_search** — Google Places 搜索地点. 支持多查询.
- **places_map_display_v0** — 在地图展示地点. 需先用 places_search 拿 place_id.
- **search_mcp_registry** — 在 MCP 注册表搜索连接器 (关键词).
- **suggest_connectors** — 展示连接器选项给用户选 (需 search_mcp_registry 结果).
- **fetch_sports_data** — 体育数据 (比分/积分榜/比赛统计). NBA/NFL 等 19 个联赛.

## 调用示例 (4 个最常用)

### ask_user_input
```text
[TOOL:ask_user_input_v0]
[P:questions][{"question":"你的预算?","options":[{"label":"<500"},{"label":"500-2000"}]}]
[ENDTOOL]
```

### bash
```text
[TOOL:bash_tool]
[P:command]ls -la /tmp
[P:description]列出 /tmp
[ENDTOOL]
```

### str_replace
```text
[TOOL:str_replace]
[P:old_str]recieve
[P:new_str]receive
[P:path]/home/bolloon/main.py
[ENDTOOL]
```

### image_search
```text
[TOOL:image_search]
[P:query]Eiffel Tower Paris
[ENDTOOL]
```

## 关键约束

- **路径约束**: /mnt/user-data/uploads, /mnt/transcripts, /mnt/skills/{public,private,examples} 只读. 需编辑先复制到可写位置.
- **网络**: bash_tool 允许的域 — *.adobe.io, api.hibs.com, github.com, npmjs.com, pypi.org 等.
- **p2p 路由**: 远程访客/智能体 调用时根据 channel 调整信任度 (见 channel 层).
