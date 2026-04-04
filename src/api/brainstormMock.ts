import type {
  AutocompleteRequest,
  AutocompleteResponse,
  CanvasCommand,
} from './brainstormContract'
import { BRAINSTORM_CONTRACT_VERSION } from './brainstormContract'
import { config } from '../config'

const API_KEY = config.anthropicApiKey || undefined

const IDEAS = [
  'User personas',
  'Key pain points',
  'Success metrics',
  'Risks & assumptions',
  'MVP scope',
  'Next experiment',
]

function clampNewShapes(maxNewShapes: number | undefined) {
  return Math.max(1, Math.min(maxNewShapes ?? 2, 2))
}

function computePlacements(req: AutocompleteRequest, count: number) {
  const bottom = req.snapshot.shapes.reduce<{ x: number; y: number }>(
    (acc, s) => (s.y > acc.y ? { x: s.x, y: s.y } : acc),
    { x: 300, y: 200 },
  )

  const baseY = bottom.y + 180
  const centerX = bottom.x
  const spread = 220
  const startX = centerX - (count - 1) * (spread / 2)

  return Array.from({ length: count }).map((_, i) => ({
    x: Math.round(startX + i * spread),
    y: Math.round(baseY),
  }))
}

function fallbackRandomIdeas(req: AutocompleteRequest): AutocompleteResponse {
  const count = clampNewShapes(req.maxNewShapes)
  const placements = computePlacements(req, count)
  const now = Date.now()
  const prefixed = Boolean(req.hint && req.hint.trim())

  const commands: CanvasCommand[] = Array.from({ length: count }).map((_, i) => {
    const idea = IDEAS[(now + i) % IDEAS.length] ?? 'New idea'
    const prefix = prefixed ? (i % 2 === 0 ? '❓ ' : '⚠️ ') : ''
    return {
      action: 'create',
      id: `shape:auto-${now + i}`,
      shapeType: 'note',
      x: placements[i]!.x,
      y: placements[i]!.y,
      text: `${prefix}${idea}`,
    }
  })

  return { contractVersion: BRAINSTORM_CONTRACT_VERSION, commands }
}

function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i)
  if (fenced?.[1]) return fenced[1]
  const obj = text.match(/\{[\s\S]*\}/)
  if (obj?.[0]) return obj[0]
  return null
}

export async function mockAutocomplete(
  req: AutocompleteRequest,
): Promise<AutocompleteResponse> {
  const count = clampNewShapes(req.maxNewShapes)
  const placements = computePlacements(req, count)
  const now = Date.now()
  const hint = req.hint?.trim()
  const prefixed = Boolean(hint)

  try {
    if (!API_KEY) throw new Error('missing_api_key')

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20240620',
        max_tokens: 900,
        system: `You are an AI collaborator on a brainstorm canvas.
Look at existing shapes and suggest 1-2 logical next ideas.
Return ONLY valid JSON matching this TypeScript type:
{ contractVersion: 1, commands: Array<{ action: "create", id: "shape:auto-N", shapeType: "note", x: number, y: number, text: string }> }
Do not include any other keys, markdown, or commentary.`,
        messages: [
          {
            role: 'user',
            content: `Canvas snapshot JSON:\n${JSON.stringify(req.snapshot, null, 2)}\n\n${
              hint ? `Hint:\n${hint}\n\n` : ''
            }Generate up to ${count} new notes. Use ids like shape:auto-N.`,
          },
        ],
      }),
    })

    if (!res.ok) throw new Error('anthropic_http_error')

    const data = (await res.json()) as any
    const text: string = data?.content?.[0]?.text ?? ''
    const json = extractJsonObject(text)
    if (!json) throw new Error('no_json')

    const parsed = JSON.parse(json) as any
    const rawCommands = Array.isArray(parsed?.commands) ? parsed.commands : null
    if (!rawCommands) throw new Error('bad_schema')

    const texts = rawCommands
      .filter((c: any) => c && c.action === 'create' && c.shapeType === 'note')
      .map((c: any) => (typeof c.text === 'string' ? c.text : ''))
      .filter((t: string) => t.trim().length > 0)
      .slice(0, count)

    const commands: CanvasCommand[] = Array.from({ length: count }).map((_, i) => ({
      action: 'create',
      id: `shape:auto-${now + i}`,
      shapeType: 'note',
      x: placements[i]!.x,
      y: placements[i]!.y,
      text: `${prefixed ? (i % 2 === 0 ? '❓ ' : '⚠️ ') : ''}${
        texts[i] ?? IDEAS[(now + i) % IDEAS.length] ?? 'New idea'
      }`,
    }))

    return { contractVersion: BRAINSTORM_CONTRACT_VERSION, commands }
  } catch {
    return fallbackRandomIdeas(req)
  }
}
