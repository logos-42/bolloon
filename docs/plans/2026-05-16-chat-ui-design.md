# Bolloon Agent 对话界面设计

## 概述

为 Bolloon Agent 设计一个混合模式（终端+浏览器）的对话界面，用户可在浏览器中与 AI Agent 对话。

## 交互流程

1. 终端运行 `npm run dev` 启动
2. 终端显示启动进度，浏览器自动打开 Web 界面
3. 用户在浏览器中发送消息
4. 后端处理并通过 P2P 网络通信
5. AI 回复显示在浏览器中

## 终端显示

```
🤖 Bolloon Agent

  身份生成...  ✓
  P2P连接...  ✓
  HTTP服务...  ✓

  🌐 浏览器已打开 → http://localhost:54188
```

## Web 界面设计

### 布局
- 固定高度视口，全屏显示
- 顶部标题栏
- 中部消息区域（可滚动）
- 底部输入框

### 消息样式
- 用户消息：右对齐，蓝色/深色背景
- AI消息：左对齐，浅色背景
- 时间戳在消息下方（小字灰色）

### 视觉风格
- 简洁对话流，无多余装饰
- 适合纯对话场景
- 深色/浅色主题可扩展

## 技术方案

### 目录结构
```
src/
  web/
    index.html      # 极简HTML
    style.css       # 对话样式
    client.js       # 前端JS
  server.ts         # Express + SSE后端
```

### 端口
- 默认 3000
- 可通过 PORT 环境变量配置

### API
- `GET /` - 返回 Web 界面
- `GET /events` - SSE 流式事件
- `POST /message` - 发送消息

## 消息格式

### 请求
```json
POST /message
{ "text": "读取 想法.md" }
```

### 响应 (SSE)
```
data: {"type":"user","content":"读取 想法.md"}
data: {"type":"ai","content":"📝 摘要..."}
data: {"type":"done"}
```

## 状态

- [ ] 创建 Web 静态文件
- [ ] 实现 Express + SSE 后端
- [ ] 集成到 main.ts
- [ ] 测试完整流程