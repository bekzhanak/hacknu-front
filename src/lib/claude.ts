import { config } from '../config'

const CLIENT_MODEL_OVERRIDE = config.anthropicModel

export type NodeCommand = {
  action: 'create' | 'update' | 'delete'
  id: string
  label?: string
  nodeType?: 'idea' | 'question' | 'decision' | 'action'
  x?: number
  y?: number
  color?: string
  sourceId?: string  // for creating edges
  edgeLabel?: string
}

export async function askClaude(
  systemPrompt: string,
  userMessage: string
): Promise<NodeCommand[]> {

  const res = await fetch('/api/anthropic/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemPrompt,
      userMessage,
      model: CLIENT_MODEL_OVERRIDE,
      max_tokens: 1500,
    }),
  })

  if (!res.ok) {
    const errorText = await res.text().catch(() => '')
    throw new Error(`Anthropic proxy error ${res.status}: ${errorText}`)
  }

  const data = await res.json()
  if (!data.content || data.content.length === 0) return []
  const text: string = data.content[0].text

  const match =
    text.match(/```json\n?([\s\S]*?)\n?```/) || text.match(/(\[[\s\S]*\])/)
  if (!match) return []

  return JSON.parse(match[1] || match[0]) as NodeCommand[]
}
