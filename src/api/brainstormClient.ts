import type {
  AutocompleteRequest,
  AutocompleteResponse,
} from './brainstormContract'
import { config } from '../config'

const API_BASE_URL = config.brainstormApiBaseUrl || undefined

type BackendCompleteResponse = {
  change_id: string
  operations_count: number
  reasoning: string
}

export async function completeAction(params: {
  roomId: string
  changeId: string
  action: 'approve' | 'reject' | 'edit'
  editPrompt?: string
}): Promise<{ status: string; newChangeId?: string | null }> {
  if (!API_BASE_URL) throw new Error('Missing VITE_BRAINSTORM_API_BASE_URL')

  const res = await fetch(`${API_BASE_URL}/complete/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      room_id: params.roomId,
      change_id: params.changeId,
      action: params.action,
      edit_prompt: params.editPrompt ?? null,
    }),
  })

  if (!res.ok) {
    throw new Error(`Complete action failed: ${res.status} ${res.statusText}`)
  }

  const json = (await res.json()) as any
  return {
    status: String(json?.status ?? 'ok'),
    newChangeId: (json?.new_change_id ?? null) as string | null,
  }
}

export async function autocomplete(
  req: AutocompleteRequest,
): Promise<AutocompleteResponse> {
  if (!API_BASE_URL) throw new Error('Missing VITE_BRAINSTORM_API_BASE_URL')

  const res = await fetch(`${API_BASE_URL}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      room_id: req.roomId,
      // Best-effort context for backends that accept extra fields (FastAPI ignores extras by default).
      snapshot: req.snapshot,
      hint: req.hint,
      max_new_shapes: req.maxNewShapes,
      contract_version: req.contractVersion,
    }),
  })

  if (!res.ok) {
    throw new Error(`Autocomplete failed: ${res.status} ${res.statusText}`)
  }

  const data = (await res.json()) as BackendCompleteResponse
  return {
    contractVersion: req.contractVersion,
    commands: [],
    changeId: data.change_id,
    operationsCount: data.operations_count,
    reasoning: data.reasoning,
  }
}
