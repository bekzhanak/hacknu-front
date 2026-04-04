import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

type AnthropicProxyOptions = {
  apiKey?: string
  model?: string
}

function readBody(req: any): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: any) => {
      data += chunk
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function json(res: any, statusCode: number, payload: unknown) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload))
}

async function callAnthropicMessage(opts: {
  apiKey: string
  model: string
  systemPrompt: string
  userMessage: string
  maxTokens: number
}) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': opts.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens,
      system: opts.systemPrompt,
      messages: [{ role: 'user', content: opts.userMessage }],
    }),
  })

  const bodyText = await res.text()
  let bodyJson: any = undefined
  try {
    bodyJson = bodyText ? JSON.parse(bodyText) : undefined
  } catch {
    bodyJson = undefined
  }

  return { res, bodyText, bodyJson }
}

function anthropicProxyPlugin(options: AnthropicProxyOptions): Plugin {
  const candidates = [
    options.model,
    'claude-3-7-sonnet-latest',
    'claude-3-5-sonnet-latest',
    'claude-3-5-haiku-latest',
    'claude-3-haiku-20240307',
  ].filter(Boolean) as string[]

  return {
    name: 'anthropic-proxy',
    configureServer(server) {
      server.middlewares.use('/api/anthropic/messages', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.setHeader('Allow', 'POST')
          return res.end()
        }

        const apiKey = options.apiKey
        if (!apiKey) {
          return json(res, 500, {
            error: 'Missing ANTHROPIC_API_KEY on the server.',
          })
        }

        let payload: any = undefined
        try {
          const raw = await readBody(req)
          payload = raw ? JSON.parse(raw) : {}
        } catch {
          return json(res, 400, { error: 'Invalid JSON body.' })
        }

        const systemPrompt = String(payload.systemPrompt ?? '')
        const userMessage = String(payload.userMessage ?? '')
        const maxTokens = Number(payload.max_tokens ?? 1500)
        const preferredModel =
          typeof payload.model === 'string' && payload.model.trim()
            ? payload.model.trim()
            : undefined

        const modelList = preferredModel
          ? [preferredModel, ...candidates.filter(m => m !== preferredModel)]
          : candidates

        for (const model of modelList) {
          const { res: upstream, bodyText, bodyJson } =
            await callAnthropicMessage({
              apiKey,
              model,
              systemPrompt,
              userMessage,
              maxTokens,
            })

          const isModelNotFound =
            upstream.status === 404 &&
            bodyJson?.type === 'error' &&
            bodyJson?.error?.type === 'not_found_error' &&
            typeof bodyJson?.error?.message === 'string' &&
            bodyJson.error.message.includes('model:')

          if (isModelNotFound) continue

          res.statusCode = upstream.status
          const ct = upstream.headers.get('content-type')
          if (ct) res.setHeader('Content-Type', ct)
          return res.end(bodyText)
        }

        return json(res, 404, {
          error: 'No available Anthropic model found (all candidates returned not_found_error).',
          tried: modelList,
        })
      })
    },
    configurePreviewServer(server) {
      // Same proxy in `vite preview` (useful for demos).
      server.middlewares.use('/api/anthropic/messages', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.setHeader('Allow', 'POST')
          return res.end()
        }

        const apiKey = options.apiKey
        if (!apiKey) {
          return json(res, 500, {
            error: 'Missing ANTHROPIC_API_KEY on the server.',
          })
        }

        let payload: any = undefined
        try {
          const raw = await readBody(req)
          payload = raw ? JSON.parse(raw) : {}
        } catch {
          return json(res, 400, { error: 'Invalid JSON body.' })
        }

        const systemPrompt = String(payload.systemPrompt ?? '')
        const userMessage = String(payload.userMessage ?? '')
        const maxTokens = Number(payload.max_tokens ?? 1500)
        const preferredModel =
          typeof payload.model === 'string' && payload.model.trim()
            ? payload.model.trim()
            : undefined

        const modelList = preferredModel
          ? [preferredModel, ...candidates.filter(m => m !== preferredModel)]
          : candidates

        for (const model of modelList) {
          const { res: upstream, bodyText, bodyJson } =
            await callAnthropicMessage({
              apiKey,
              model,
              systemPrompt,
              userMessage,
              maxTokens,
            })

          const isModelNotFound =
            upstream.status === 404 &&
            bodyJson?.type === 'error' &&
            bodyJson?.error?.type === 'not_found_error' &&
            typeof bodyJson?.error?.message === 'string' &&
            bodyJson.error.message.includes('model:')

          if (isModelNotFound) continue

          res.statusCode = upstream.status
          const ct = upstream.headers.get('content-type')
          if (ct) res.setHeader('Content-Type', ct)
          return res.end(bodyText)
        }

        return json(res, 404, {
          error: 'No available Anthropic model found (all candidates returned not_found_error).',
          tried: modelList,
        })
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiKey = env.ANTHROPIC_API_KEY || env.VITE_ANTHROPIC_API_KEY
  const model = env.ANTHROPIC_MODEL || env.VITE_ANTHROPIC_MODEL
  const portRaw = env.VITE_PORT
  const port = portRaw ? Number(portRaw) : undefined
  const hostRaw = env.VITE_HOST || env.VITE_DEV_HOST
  const host = hostRaw && hostRaw.trim() ? hostRaw.trim() : true

  return {
    // Only expose safe client env vars (prevents accidentally shipping API keys).
    envPrefix: [
      'VITE_LIVEBLOCKS_PUBLIC',
      'VITE_ANTHROPIC_MODEL',
      'VITE_AI_',
      'VITE_ROOM_',
      'VITE_FRONTEND_',
      'VITE_BRAINSTORM_',
    ],
    plugins: [react(), anthropicProxyPlugin({ apiKey, model })],
    server: {
      host,
      port: port && Number.isFinite(port) ? port : undefined,
      strictPort: true,
    },
  }
})
