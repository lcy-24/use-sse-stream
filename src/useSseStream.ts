import { ref, onScopeDispose } from 'vue'
import type { Ref } from 'vue'

export type SseStatus = 'idle' | 'connecting' | 'open' | 'error' | 'closed'

export interface UseSseStreamOptions {
  /** 请求地址，支持函数以读取最新值 */
  url: string | (() => string)
  /** 请求方法，默认 POST（兼容需要 body 的大模型接口） */
  method?: 'GET' | 'POST'
  /** 请求头，支持函数 */
  headers?: Record<string, string> | (() => Record<string, string>)
  /** 请求体，POST 时使用（对象会自动 JSON.stringify） */
  body?: any
  withCredentials?: boolean
  /** 流格式：'sse' 解析标准 EventSource 帧；'text' 直接累积原始文本 */
  format?: 'sse' | 'text'
  /** 从原始分片提取展示文本，默认自动识别 OpenAI / Dify 等常见协议 */
  extract?: (chunk: string) => string
  /** 用累积文本解析出 data，默认尝试 JSON.parse */
  parse?: (text: string) => any
  /** 每个分片到达时触发（原始分片） */
  onMessage?: (chunk: string, event?: string) => void
  onOpen?: (response: Response) => void
  onError?: (error: unknown) => void
  onClose?: () => void
  autoReconnect?: boolean
  maxRetries?: number
  /** 初始重连延迟（毫秒），按重试次数线性递增 */
  retryDelay?: number
}

export interface UseSseStreamReturn {
  /** 累积的展示文本（打字机效果的数据源） */
  text: Ref<string>
  /** parse 之后的完整数据 */
  data: Ref<any>
  status: Ref<SseStatus>
  error: Ref<unknown>
  connect: () => Promise<void>
  close: () => void
}

function defaultExtract(chunk: string): string {
  try {
    const obj = JSON.parse(chunk)
    if (typeof obj.answer === 'string') return obj.answer
    const delta = obj.choices?.[0]?.delta?.content
    if (delta != null) return String(delta)
    const msg = obj.choices?.[0]?.message?.content
    if (msg != null) return String(msg)
    if (typeof obj.content === 'string') return obj.content
    if (typeof obj.text === 'string') return obj.text
    if (typeof obj.delta === 'string') return obj.delta
    return chunk
  } catch {
    return chunk
  }
}

/** 从 buffer 中解析出完整的 SSE 帧，返回未消费的剩余 buffer */
function consumeSse(
  buffer: string,
  onMessage: (data: string, event?: string) => void
): string {
  const normalized = buffer.replace(/\r\n/g, '\n')
  let idx = normalized.indexOf('\n\n')
  while (idx !== -1) {
    const rawEvent = normalized.slice(0, idx)
    const dataLines: string[] = []
    let event = 'message'
    for (const line of rawEvent.split('\n')) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
      else if (line.startsWith('event:')) event = line.slice(6).trim()
    }
    if (dataLines.length) onMessage(dataLines.join('\n'), event)
    idx = normalized.indexOf('\n\n', idx + 2)
  }
  // 返回剩余部分（保留未换行结束的分片）
  const lastDouble = normalized.lastIndexOf('\n\n')
  return lastDouble === -1 ? buffer : buffer.slice(lastDouble + 2)
}

/**
 * 大模型流式输出的 Vue3 组合式函数。
 *
 * @example
 * const { text, status, connect, close } = useSseStream({
 *   url: '/api/chat/stream',
 *   body: { question: '你好' },
 *   onMessage: (chunk) => console.log(chunk),
 * })
 * await connect()
 */
export function useSseStream(options: UseSseStreamOptions): UseSseStreamReturn {
  const text = ref('')
  const data = ref<any>(null)
  const status = ref<SseStatus>('idle')
  const error = ref<unknown>(null)

  let controller: AbortController | null = null
  let retryCount = 0
  let disposed = false

  const extract = options.extract ?? defaultExtract

  function resolveUrl(): string {
    return typeof options.url === 'function' ? options.url() : options.url
  }

  function resolveHeaders(): Record<string, string> {
    return typeof options.headers === 'function' ? options.headers() : (options.headers ?? {})
  }

  async function connect(): Promise<void> {
    if (status.value === 'connecting' || status.value === 'open') return
    disposed = false
    controller = new AbortController()
    status.value = 'connecting'
    text.value = ''
    data.value = null
    error.value = null

    try {
      const method = options.method ?? 'POST'
      const init: RequestInit = {
        method,
        headers: {
          Accept: 'text/event-stream',
          ...resolveHeaders(),
        },
        signal: controller.signal,
        credentials: options.withCredentials ? 'include' : 'same-origin',
      }
      if (method !== 'GET' && options.body !== undefined) {
        init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
      }

      const response = await fetch(resolveUrl(), init)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (!response.body) throw new Error('Response body is empty')
      status.value = 'open'
      retryCount = 0
      options.onOpen?.(response)

      const reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''

      const handleChunk = (chunk: string, event?: string) => {
        text.value += extract(chunk)
        options.onMessage?.(chunk, event)
        try {
          data.value = options.parse ? options.parse(text.value) : JSON.parse(text.value)
        } catch {
          /* 尚未完整 JSON，忽略 */
        }
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        if (options.format === 'sse') {
          buffer = consumeSse(buffer, handleChunk)
        } else {
          if (buffer.length) {
            handleChunk(buffer)
            buffer = ''
          }
        }
      }

      const tail = decoder.decode()
      if (tail) buffer += tail
      if (options.format === 'sse') {
        consumeSse(buffer + '\n\n', handleChunk)
      } else if (buffer.length) {
        handleChunk(buffer)
      }

      status.value = 'closed'
      options.onClose?.()
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        status.value = 'closed'
        return
      }
      status.value = 'error'
      error.value = err
      options.onError?.(err)

      if (options.autoReconnect && !disposed && retryCount < (options.maxRetries ?? 3)) {
        retryCount++
        const delay = (options.retryDelay ?? 1000) * retryCount
        setTimeout(() => {
          if (!disposed) void connect()
        }, delay)
      }
    }
  }

  function close(): void {
    disposed = true
    controller?.abort()
    if (status.value !== 'closed') status.value = 'closed'
  }

  onScopeDispose(close)

  return { text, data, status, error, connect, close }
}
