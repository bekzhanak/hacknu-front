import { createClient, LiveList, LiveMap, LiveObject } from '@liveblocks/client'
import { createRoomContext } from '@liveblocks/react'
import { config } from './config'

const client = createClient({
  publicApiKey: config.liveblocksPublicKey,
})

type Presence = {
  name?: string
  color?: string
  cursor?: { x: number; y: number } | null
}

// Storage schema (validated by backend).
export type TLColor =
  | 'black'
  | 'grey'
  | 'light-violet'
  | 'violet'
  | 'blue'
  | 'light-blue'
  | 'yellow'
  | 'orange'
  | 'green'
  | 'light-green'
  | 'light-red'
  | 'red'
  | 'white'

export type TLFill = 'none' | 'semi' | 'solid' | 'pattern'
export type TLDash = 'draw' | 'solid' | 'dashed' | 'dotted'
export type TLSize = 's' | 'm' | 'l' | 'xl'
export type TLFont = 'draw' | 'sans' | 'serif' | 'mono'
export type TLAlign = 'start' | 'middle' | 'end'
export type TLVerticalAlign = 'start' | 'middle' | 'end'

export type RichText =
  | { type: 'doc'; content: any[] }
  // Allow any Prosemirror-compatible JSON for now.
  | Record<string, any>

export type CanvasShape =
  | (TLBaseShape & { type: 'geo'; props: Record<string, any> })
  | (TLBaseShape & { type: 'arrow'; props: Record<string, any> })
  | (TLBaseShape & { type: 'note'; props: Record<string, any> })
  | (TLBaseShape & { type: 'text'; props: Record<string, any> })
  | (TLBaseShape & { type: 'frame'; props: Record<string, any> })
  | (TLBaseShape & { type: 'line'; props: Record<string, any> })
  | (TLBaseShape & { type: 'draw'; props: Record<string, any> })
  | (TLBaseShape & { type: 'group'; props: Record<string, any> })

export type TLBaseShape = {
  id: string
  type: string
  x: number
  y: number
  rotation: number
  index: string
  parentId: string
  isLocked: boolean
  opacity: number
  meta: Record<string, any>
}

export type PendingChange = {
  id: string
  agentId: string
  status: 'pending'
  operations: Array<{
    op: 'add_shape' | 'update_shape' | 'delete_shape'
    shape?: CanvasShape
    shapeId?: string
    updates?: Record<string, any>
  }>
  reasoning: string
  createdAt: string
}

export type AgentInfo = {
  id: string
  name: string
}

export type AgentChatMessage = {
  id: string
  agentId: string
  role: 'user' | 'agent'
  authorKey: string
  authorName: string
  content: string
  createdAt: string
  deepResearch?: boolean
}

export type RoomMeta = {
  roomId: string
  roomName: string
  createdAt: string
}

type Storage = {
  shapes: LiveMap<string, CanvasShape>
  pendingChanges: LiveMap<string, PendingChange>
  agents: LiveMap<string, AgentInfo>
  agentChats: LiveMap<string, LiveList<AgentChatMessage>>
  meta: LiveObject<RoomMeta>
}

export const {
  RoomProvider,
  useBroadcastEvent,
  useEventListener,
  useMutation,
  useOthers,
  useSyncStatus,
  useSelf,
  useStorage,
  useUpdateMyPresence,
} = createRoomContext<Presence, Storage>(client)

export type { Presence, Storage }
