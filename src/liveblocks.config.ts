import { createClient, LiveList, LiveObject } from "@liveblocks/client"
import { createRoomContext } from "@liveblocks/react"
import { config } from "./config"

const client = createClient({
  publicApiKey: config.liveblocksPublicKey,
})

export type FlowNode = {
  id: string
  type: string
  position: { x: number; y: number }
  data: { label: string; color?: string }
  style?: Record<string, string | number>
  width?: number
  height?: number
}

export type FlowEdge = {
  id: string
  source: string
  target: string
  label?: string
}

type Storage = {
  nodes: LiveList<LiveObject<FlowNode>>
  edges: LiveList<LiveObject<FlowEdge>>
}

type Presence = {
  cursor: { x: number; y: number } | null
}

export const {
  RoomProvider,
  useStorage,
  useMutation,
  useOthers,
  useUpdateMyPresence,
} = createRoomContext<Presence, Storage>(client)
