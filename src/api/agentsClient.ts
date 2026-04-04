import { config } from '../config'

const API_BASE_URL = config.brainstormApiBaseUrl || undefined

export type BackendAgentInfo = {
  id: string
  name: string
  type: 'autocomplete' | 'chatbot'
  is_default?: boolean
  created_at: string
}

export type ListAgentsResponse = { agents: BackendAgentInfo[] }

export type CreateAgentRequest = { name: string; type?: 'chatbot' }
export type CreateAgentResponse = { agent: BackendAgentInfo }

export type AgentRunRequest = { room_id: string; prompt: string; mode?: 'generate' | 'query' }
export type AgentRunResponse = {
  change_id: string | null
  operations_count: number | null
  reasoning: string | null
  answer: string | null
  referenced_shapes: string[] | null
}

export type TextEntry = {
  id: string
  type: 'text'
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

export type ChangeEntry = {
  id: string
  type: 'change'
  change_id: string
  change_status: 'pending' | 'approved' | 'rejected'
  operations_summary: string
  created_at: string
}

export type MessagesResponse = { messages: Array<TextEntry | ChangeEntry> }

function assertApiBaseUrl(): string {
  if (!API_BASE_URL) throw new Error('Missing VITE_BRAINSTORM_API_BASE_URL')
  return API_BASE_URL
}

export function agentApiEnabled(): boolean {
  return !!API_BASE_URL
}

export async function listAgents(roomId: string): Promise<ListAgentsResponse> {
  const base = assertApiBaseUrl()
  const res = await fetch(`${base}/agents/${encodeURIComponent(roomId)}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok) throw new Error(`List agents failed: ${res.status} ${res.statusText}`)
  return (await res.json()) as ListAgentsResponse
}

export async function createAgent(roomId: string, req: CreateAgentRequest): Promise<CreateAgentResponse> {
  const base = assertApiBaseUrl()
  const res = await fetch(`${base}/agents/${encodeURIComponent(roomId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: req.name,
      type: req.type ?? 'chatbot',
    }),
  })
  if (!res.ok) throw new Error(`Create agent failed: ${res.status} ${res.statusText}`)
  return (await res.json()) as CreateAgentResponse
}

export async function runAgent(agentId: string, req: AgentRunRequest): Promise<AgentRunResponse> {
  const base = assertApiBaseUrl()
  const res = await fetch(`${base}/agent/${encodeURIComponent(agentId)}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      room_id: req.room_id,
      prompt: req.prompt,
      mode: req.mode ?? 'generate',
    }),
  })
  if (!res.ok) throw new Error(`Run agent failed: ${res.status} ${res.statusText}`)
  return (await res.json()) as AgentRunResponse
}

export async function getAgentMessages(params: {
  agentId: string
  limit?: number
  offset?: number
}): Promise<MessagesResponse> {
  const base = assertApiBaseUrl()
  const limit = params.limit ?? 50
  const offset = params.offset ?? 0
  const qs = new URLSearchParams()
  qs.set('limit', String(limit))
  qs.set('offset', String(offset))
  const res = await fetch(`${base}/agent/${encodeURIComponent(params.agentId)}/messages?${qs.toString()}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok) throw new Error(`Get messages failed: ${res.status} ${res.statusText}`)
  return (await res.json()) as MessagesResponse
}

