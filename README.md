# use-sse-stream

Vue3 组合式函数，用于对接大模型的**流式输出（SSE / 打字机效果）**。

基于原生 `fetch + ReadableStream`，支持 `POST` 请求体、SSE 帧解析、自动提取常见协议（OpenAI / Dify）的回复文本、中断与自动重连，零依赖。

## 特性

- 🔌 支持 `GET` / `POST`（大模型接口常需要 `POST` 携带 body）
- 🧩 同时支持标准 SSE 帧与原始文本流两种格式
- 🎯 内置协议识别：自动从 OpenAI、Dify 等常见响应里提取 `answer` / `choices[].delta.content`
- ⏱ 打字机累积：`text` 直接作为展示数据源
- ⏹ 支持 `close()` 中断、`autoReconnect` 自动重连
- ✅ 全量 TypeScript

## 安装

```bash
npm install use-sse-stream
```

> peer 依赖：`vue >= 3.3.0`。

## 快速开始

```vue
<script setup lang="ts">
import { useSseStream } from 'use-sse-stream'

const { text, status, error, connect, close } = useSseStream({
  url: '/api/chat/stream',
  body: { question: '介绍一下你自己' },
  onMessage: (chunk) => console.log('chunk:', chunk),
  onError: (e) => console.error(e),
})
</script>

<template>
  <div>
    <button :disabled="status === 'connecting'" @click="connect">发送</button>
    <button @click="close">停止</button>
    <p>{{ text }}</p>
  </div>
</template>
```

## API

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `url` | `string \| () => string` | 请求地址 |
| `method` | `'GET' \| 'POST'` | 默认 `POST` |
| `headers` | `object \| () => object` | 请求头 |
| `body` | `any` | POST 请求体（对象自动 `JSON.stringify`） |
| `format` | `'sse' \| 'text'` | 默认 `sse` |
| `extract` | `(chunk) => string` | 从分片提取展示文本，默认自动识别常见协议 |
| `parse` | `(text) => any` | 用累积文本解析 `data`，默认尝试 `JSON.parse` |
| `onMessage` / `onOpen` / `onError` / `onClose` | 回调 | 生命周期回调 |
| `autoReconnect` / `maxRetries` / `retryDelay` | — | 自动重连（默认最多 3 次） |

返回值：`text`、`data`、`status`、`error`、`connect()`、`close()`。

## 自定义协议

如果你的接口不是标准 OpenAI / Dify 格式，用 `extract` 自定义提取逻辑：

```ts
useSseStream({
  url: '/my/stream',
  extract: (chunk) => {
    const obj = JSON.parse(chunk)
    return obj.payload?.message ?? ''
  },
})
```

## License

MIT
