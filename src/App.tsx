'use client'
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { LiveList, LiveMap, LiveObject } from '@liveblocks/client'
import { Tldraw, type Editor, type TLShape } from 'tldraw'
import 'tldraw/tldraw.css'
import { ClientSideSuspense } from '@liveblocks/react'
import type { RecordsDiff, UnknownRecord } from '@tldraw/store'
import { toRichText } from '@tldraw/tlschema'
import { ZERO_INDEX_KEY, getIndexAbove, type IndexKey } from '@tldraw/utils'
import { generateKeyBetween } from 'jittered-fractional-indexing'
import { useTldrawUser } from '@tldraw/editor'

import {
  RoomProvider,
  useMutation,
  useOthers,
  useSelf,
  useSyncStatus,
  useStorage,
  useUpdateMyPresence,
} from './liveblocks.tldraw'

import { autocomplete, completeAction } from './api/brainstormClient'
import { BRAINSTORM_CONTRACT_VERSION, type CanvasCommand } from './api/brainstormContract'
import {
  agentApiEnabled,
  createAgent as apiCreateAgent,
  getAgentMessages as apiGetAgentMessages,
  listAgents as apiListAgents,
  runAgent as apiRunAgent,
} from './api/agentsClient'
import { getUser, type ApiUser } from './api/user'
import { createRoom, getRooms, joinRoom, type RoomEntry } from './api/rooms'
import { applyFrontendHostToUrl } from './api/frontendHost'
import { config } from './config'
import type {
  AgentChatMessage,
  AgentInfo,
  CanvasShape,
  PendingChange,
  RichText,
  RoomMeta,
  TLAlign,
  TLColor,
  TLDash,
  TLFill,
  TLFont,
  TLSize,
  TLVerticalAlign,
} from './liveblocks.tldraw'

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to legacy copy
  }

  try {
    const el = document.createElement('textarea')
    el.value = text
    el.setAttribute('readonly', 'true')
    el.style.position = 'fixed'
    el.style.left = '-9999px'
    el.style.top = '0'
    document.body.appendChild(el)
    el.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(el)
    return ok
  } catch {
    return false
  }
}

function useLocation() {
  const [location, setLocation] = useState(() => {
    if (typeof window === 'undefined') return { pathname: '/', search: '' }
    return {
      pathname: window.location.pathname || '/',
      search: window.location.search || '',
    }
  })

  useEffect(() => {
    const onPopState = () =>
      setLocation({
        pathname: window.location.pathname || '/',
        search: window.location.search || '',
      })
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const navigate = (to: string) => {
    if (typeof window === 'undefined') return
    const url = new URL(to, window.location.origin)
    window.history.pushState({}, '', url.toString())
    setLocation({ pathname: url.pathname || '/', search: url.search || '' })
  }

  return { pathname: location.pathname, search: location.search, navigate }
}

function getRoomIdFromPath(pathname: string): string | null {
  if (!pathname.startsWith('/rooms/')) return null
  const rest = pathname.slice('/rooms/'.length)
  const id = rest.split('/')[0]
  if (!id) return null
  return decodeURIComponent(id)
}

function getRoomNameFromSearch(search: string): string | null {
  try {
    const name = new URLSearchParams(search).get('name')
    return name && name.trim() ? name : null
  } catch {
    return null
  }
}

function roomUrl(id: string, name: string) {
  return `/rooms/${encodeURIComponent(id)}?name=${encodeURIComponent(name)}`
}

function parseJoinInput(input: string): { roomId: string | null; name?: string } {
  const trimmed = input.trim()
  if (!trimmed) return { roomId: null }

  try {
    const url = new URL(trimmed)
    const roomId = getRoomIdFromPath(url.pathname)
    if (roomId) {
      const name = url.searchParams.get('name') ?? undefined
      return { roomId, name }
    }

    // Legacy support: /room/room-{uuid}
    if (url.pathname.startsWith('/room/')) {
      const legacy = decodeURIComponent(url.pathname.slice('/room/'.length))
      const normalized = legacy.startsWith('room-') ? legacy.slice('room-'.length) : legacy
      const name = url.searchParams.get('name') ?? undefined
      return { roomId: normalized || null, name }
    }
  } catch {
    // not a URL
  }

  const normalized = trimmed.startsWith('room-') ? trimmed.slice('room-'.length) : trimmed
  return { roomId: normalized || null }
}

function toShapeId(id: string) {
  return (id.startsWith('shape:') ? id : `shape:${id}`) as TLShape['id']
}

function getShapeText(shape: TLShape): string | undefined {
  const maybeProps = (shape as unknown as { props?: unknown }).props
  if (!maybeProps || typeof maybeProps !== 'object') return undefined

  const directText = (maybeProps as { text?: unknown }).text
  if (typeof directText === 'string') return directText

  const richText = (maybeProps as { richText?: unknown }).richText
  if (!richText || typeof richText !== 'object') return undefined

  const chunks: string[] = []
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    const text = (node as { text?: unknown }).text
    if (typeof text === 'string') chunks.push(text)
    const content = (node as { content?: unknown }).content
    if (Array.isArray(content)) content.forEach(visit)
  }
  visit(richText)

  const joined = chunks.join('')
  return joined.trim() ? joined : undefined
}

function buildSnapshot(editor: Editor) {
  const shapes = editor
    .getCurrentPageShapes()
    .slice(0, 40)
    .map((s) => ({
      id: String(s.id),
      type: String(s.type),
      x: Math.round(s.x),
      y: Math.round(s.y),
      text: getShapeText(s),
    }))

  return { shapes }
}

function applyCommandsToEditor(editor: Editor, commands: CanvasCommand[]) {
  commands.forEach((cmd) => {
    if (cmd.action === 'create' && cmd.shapeType === 'note') {
      const id = toShapeId(cmd.id)
      editor.createShape({
        id,
        type: 'note',
        x: cmd.x,
        y: cmd.y,
        opacity: 0,
        props: { richText: toRichText(cmd.text) },
        meta: { aiGenerated: true },
      } as any)
      setTimeout(() => {
        const shape = editor.getShape(id)
        if (!shape) return
        editor.updateShape({ ...shape, opacity: 1 } as any)
      }, 300)
      return
    }

    if (cmd.action === 'update') {
      const shape = editor.getShape(toShapeId(cmd.id))
      if (!shape) return
      editor.updateShape({
        ...shape,
        x: cmd.x ?? shape.x,
        y: cmd.y ?? shape.y,
        props: {
          ...(shape as any).props,
          ...(cmd.text !== undefined ? { richText: toRichText(cmd.text) } : null),
        },
      } as any)
      return
    }

    if (cmd.action === 'delete') {
      editor.deleteShapes([toShapeId(cmd.id)])
    }
  })
}

function isValidIncomingRecord(record: unknown): boolean {
  if (!record || typeof record !== 'object') return false
  const typeName = (record as { typeName?: unknown }).typeName
  const id = (record as { id?: unknown }).id
  if (typeof id !== 'string') return false
  if (typeName === 'shape') return id.startsWith('shape:')
  return id.includes(':')
}

function avatarBgColor(color: unknown): string {
  return typeof color === 'string' && color.trim() ? color : '#94a3b8'
}

function avatarLabel(name: unknown): string {
  const str = typeof name === 'string' ? name.trim() : ''
  return (str[0] ?? 'U').toUpperCase()
}

function tlColorFromUserColor(raw: unknown): TLColor {
  if (typeof raw !== 'string') return 'violet'
  const trimmed = raw.trim()
  if (!trimmed) return 'violet'
  // If already a TL color token, accept it.
  if (
    [
      'black',
      'grey',
      'light-violet',
      'violet',
      'blue',
      'light-blue',
      'yellow',
      'orange',
      'green',
      'light-green',
      'light-red',
      'red',
      'white',
    ].includes(trimmed)
  ) {
    return trimmed as TLColor
  }

  // Basic hex parsing -> hue bucket.
  const m = /^#?([0-9a-fA-F]{6})$/.exec(trimmed)
  if (!m) return 'violet'
  const hex = m[1]!
  const r = parseInt(hex.slice(0, 2), 16) / 255
  const g = parseInt(hex.slice(2, 4), 16) / 255
  const b = parseInt(hex.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  if (d === 0) return max < 0.2 ? 'black' : max > 0.85 ? 'white' : 'grey'
  let h = 0
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  h = Math.round(h * 60)
  if (h < 0) h += 360

  if (h >= 330 || h < 20) return 'red'
  if (h >= 20 && h < 50) return 'orange'
  if (h >= 50 && h < 80) return 'yellow'
  if (h >= 80 && h < 160) return 'green'
  if (h >= 160 && h < 260) return 'blue'
  return 'violet'
}

function ShareIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <polyline points="16 6 12 2 8 6" />
      <line x1="12" y1="2" x2="12" y2="15" />
    </svg>
  )
}

function ExitIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  )
}

type RoomShellProps = {
  roomId: string
  roomName: string
  user: ApiUser
  navigate: (to: string) => void
}

function RoomShell({ roomId, roomName, user, navigate }: RoomShellProps) {
	  const initialStorage = useMemo(
	    () => ({
	      shapes: new LiveMap<string, CanvasShape>(),
	      pendingChanges: new LiveMap<string, PendingChange>(),
	      agents: new LiveMap<string, AgentInfo>([['agent-0', { id: 'agent-0', name: 'System' }]]),
	      agentChats: new LiveMap<string, LiveList<AgentChatMessage>>([
	        [
	          'agent-0',
	          new LiveList<AgentChatMessage>([]),
	        ],
	      ]),
	      meta: new LiveObject<RoomMeta>({
	        roomId,
	        roomName,
	        createdAt: new Date().toISOString(),
	      }),
	    }),
	    [roomId, roomName],
	  )

  return (
    <RoomProvider
      id={roomId}
      initialPresence={{ name: user.username, color: user.color, cursor: null }}
      initialStorage={initialStorage}
	    >
	      <ClientSideSuspense fallback={<div style={{ padding: 24 }}>Loading room…</div>}>
	        <RoomInner roomId={roomId} roomName={roomName} navigate={navigate} />
	      </ClientSideSuspense>
	    </RoomProvider>
	  )
	}

function AgentsPanelIcon({ open }: { open: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M9 4h10a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H9"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M5 4h4v16H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d={open ? 'M13 8l-3 4 3 4' : 'M11 8l3 4-3 4'}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function RoomInner({
  roomId,
  roomName,
  navigate,
}: {
  roomId: string
  roomName: string
  navigate: (to: string) => void
}) {
  const inviteFrontendHost = config.frontendHost
  const others = useOthers()
  const self = useSelf()
  const syncStatus = useSyncStatus()
	  const updateMyPresence = useUpdateMyPresence()
	  const [leftCollapsed, setLeftCollapsed] = useState(false)
	  const [rightSidebarOpen, setRightSidebarOpen] = useState(true)
	  const [rightSidebarWidth, setRightSidebarWidth] = useState<number>(() => {
	    if (typeof window === 'undefined') return 360
	    const raw = window.localStorage.getItem('hacknu.rightSidebarWidth')
	    const parsed = raw ? Number(raw) : 360
    const width = Number.isFinite(parsed) ? parsed : 360
    return Math.min(560, Math.max(280, width))
  })
  const isResizingRightSidebarRef = useRef(false)
  const [isThinkingUi, setIsThinkingUi] = useState(false)
  const [checkpointOpen, setCheckpointOpen] = useState(false)
  const [checkpointValue, setCheckpointValue] = useState('')
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [hoveredUserKey, setHoveredUserKey] = useState<string | null>(null)
  const [isUsersHover, setIsUsersHover] = useState(false)
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false)
  const [slashMenuIndex, setSlashMenuIndex] = useState(0)
  const [systemAgentId, setSystemAgentId] = useState<string>('agent-0')
  const defaultBackendAgentIdRef = useRef<string | null>(null)
  const didBootstrapAgentsRef = useRef(false)
  const didLoadMessagesRef = useRef<Set<string>>(new Set())

	  const shapesMap = useStorage((root) => root.shapes)
	  const pendingChangesMap = useStorage((root) => root.pendingChanges)
	  const agentsMap = useStorage((root) => root.agents)
	  const isStorageLoaded = syncStatus === 'synchronized' && !!shapesMap && !!pendingChangesMap && !!agentsMap
	  const shapesCount = shapesMap ? shapesMap.size : 0

  // Force a stable locale to avoid noisy missing-translation warnings in tldraw's bundled ru locale.
  const tldrawUser = useTldrawUser({
    userPreferences: {
      id: self?.id ? String(self.id) : 'user',
      name: typeof self?.presence?.name === 'string' ? self.presence.name : null,
      color: typeof self?.presence?.color === 'string' ? self.presence.color : null,
      locale: 'en',
    },
  })

  const tldrawUiOverrides = useMemo(
    () => ({
      translations: {
        ru: {
          'action.toggle-invert-zoom.menu': 'Инвертировать зум',
          'action.toggle-invert-zoom': 'Инвертировать зум',
          'action.zoom-quick': 'Быстрый зум',
          'fill-style.lined-fill': 'Линейная заливка',
          'menu.input-device': 'Устройство ввода',
        },
      },
    }),
    [],
  )

	  const agents = useMemo<AgentInfo[]>(() => {
	    if (!agentsMap) return [{ id: 'agent-0', name: 'System' }]
	    const list = Array.from(agentsMap.values())
	    return list
	  }, [agentsMap])
  const [activeAgentId, setActiveAgentId] = useState<string>('agent-0')
  const [chatInputValue, setChatInputValue] = useState('')
  const chatInputRef = useRef<HTMLInputElement | null>(null)
  const activeChatList = useStorage(
    (root) =>
      ((root as any).agentChats?.get(activeAgentId) as unknown) ?? null,
  )
  const chatMessages = useMemo<readonly AgentChatMessage[]>(
    () => {
      if (!activeChatList) return []
      const anyList = activeChatList as any
      if (Array.isArray(anyList)) return anyList as AgentChatMessage[]
      if (typeof anyList?.[Symbol.iterator] === 'function') return Array.from(anyList) as AgentChatMessage[]
      return []
    },
    [activeChatList],
  )

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem('hacknu.rightSidebarWidth', String(rightSidebarWidth))
  }, [rightSidebarWidth])

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      if (!isResizingRightSidebarRef.current) return
      const next = Math.min(560, Math.max(280, window.innerWidth - e.clientX))
      setRightSidebarWidth(next)
    }

    const handleUp = () => {
      if (!isResizingRightSidebarRef.current) return
      isResizingRightSidebarRef.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [])

  useEffect(() => {
    const trimmed = chatInputValue.trimStart()
    if (!trimmed.startsWith('/')) {
      setSlashMenuDismissed(false)
      setSlashMenuIndex(0)
      return
    }
    if (trimmed.includes(' ')) {
      setSlashMenuDismissed(true)
    }
  }, [chatInputValue])

  const editorRef = useRef<Editor | null>(null)
  const canvasHostRef = useRef<HTMLDivElement | null>(null)
  const localClipboardRef = useRef<any | null>(null)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suppressAutocompleteUntilRef = useRef<number>(0)
  const isThinkingRef = useRef(false)
  const lastAutocompleteRef = useRef<number>(0)
  const lastCursorSentAtRef = useRef<number>(0)

  const pendingChangesRef = useRef<PendingChange[]>([])
  const awaitingBackendChangeRef = useRef<typeof awaitingBackendChange>(null)
  const AUTOCOMPLETE_LEASE_TTL_MS = 20_000
  const AWAITING_BACKEND_TTL_MS = 15_000
  const autocompleteOwnerIdRef = useRef<string>(
    `tab:${typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`}`,
  )

  const pendingChanges = useMemo<PendingChange[]>(() => {
    if (!pendingChangesMap) return []
    return Array.from(pendingChangesMap.values()).filter((c) => c?.status === 'pending')
  }, [pendingChangesMap])

  const [awaitingBackendChange, setAwaitingBackendChange] = useState<{
    id: string
    operationsCount: number
    reasoning: string
    requestedAt: number
  } | null>(null)

  useEffect(() => {
    pendingChangesRef.current = pendingChanges
  }, [pendingChanges])

  useEffect(() => {
    awaitingBackendChangeRef.current = awaitingBackendChange
  }, [awaitingBackendChange])

  useEffect(() => {
    if (!awaitingBackendChange) return
    if (pendingChanges.some((c) => c.id === awaitingBackendChange.id)) {
      setAwaitingBackendChange(null)
    }
  }, [pendingChanges, awaitingBackendChange])

  useEffect(() => {
    if (!awaitingBackendChange) return
    const timer = window.setTimeout(() => {
      setAwaitingBackendChange((current) =>
        current?.id === awaitingBackendChange.id ? null : current,
      )
    }, AWAITING_BACKEND_TTL_MS)
    return () => window.clearTimeout(timer)
  }, [awaitingBackendChange, AWAITING_BACKEND_TTL_MS])

  const EMPTY_RICH_TEXT: RichText = useMemo(() => ({ type: 'doc', content: [] }), [])

  const isOneOf = <T extends readonly string[]>(value: any, allowed: T): value is T[number] =>
    typeof value === 'string' && (allowed as readonly string[]).includes(value)

  const nextIndexKeyRef = useRef<IndexKey>(ZERO_INDEX_KEY)

  const nextIndexKey = (): IndexKey => {
    const next = getIndexAbove(nextIndexKeyRef.current)
    nextIndexKeyRef.current = next
    return next
  }

  const coerceIndexKey = (value: any): string => {
    if (typeof value === 'string') {
      try {
        generateKeyBetween(value, null)
        return value
      } catch {
        // fall through
      }
    }
    return nextIndexKey()
  }

  const coerceAlign = (value: any, fallback: TLAlign = 'middle'): TLAlign => {
    if (isOneOf(value, ['start', 'middle', 'end'] as const)) return value
    if (value === 'center') return 'middle'
    if (value === 'left') return 'start'
    if (value === 'right') return 'end'
    return fallback
  }

  const coerceVerticalAlign = (value: any, fallback: TLVerticalAlign = 'middle'): TLVerticalAlign => {
    if (isOneOf(value, ['start', 'middle', 'end'] as const)) return value
    if (value === 'center') return 'middle'
    if (value === 'top') return 'start'
    if (value === 'bottom') return 'end'
    return fallback
  }

  const coerceTLColor = (value: any, fallback: TLColor = 'black'): TLColor => {
    if (
      isOneOf(
        value,
        [
          'black',
          'grey',
          'light-violet',
          'violet',
          'blue',
          'light-blue',
          'yellow',
          'orange',
          'green',
          'light-green',
          'light-red',
          'red',
          'white',
        ] as const,
      )
    )
      return value
    return fallback
  }

  const coerceTLFill = (value: any, fallback: TLFill = 'solid'): TLFill => {
    if (isOneOf(value, ['none', 'semi', 'solid', 'pattern'] as const)) return value
    return fallback
  }

  const coerceTLDash = (value: any, fallback: TLDash = 'solid'): TLDash => {
    if (isOneOf(value, ['draw', 'solid', 'dashed', 'dotted'] as const)) return value
    return fallback
  }

  const coerceTLSize = (value: any, fallback: TLSize = 'm'): TLSize => {
    if (isOneOf(value, ['s', 'm', 'l', 'xl'] as const)) return value
    return fallback
  }

  const coerceTLFont = (value: any, fallback: TLFont = 'draw'): TLFont => {
    if (isOneOf(value, ['draw', 'sans', 'serif', 'mono'] as const)) return value
    return fallback
  }

  const coerceNumber = (value: any, fallback: number) => (typeof value === 'number' ? value : fallback)

  const coerceRichText = (value: any): RichText => {
    if (value && typeof value === 'object') return value as RichText
    return EMPTY_RICH_TEXT
  }

  const sanitizePropsByType = (type: string, props: Record<string, any>): Record<string, any> => {
    if (type === 'geo') {
      const geo = typeof props.geo === 'string' ? props.geo : 'rectangle'
      return {
        geo,
        w: coerceNumber(props.w, 200),
        h: coerceNumber(props.h, 100),
        color: coerceTLColor(props.color, 'black'),
        fill: coerceTLFill(props.fill, 'solid'),
        dash: coerceTLDash(props.dash, 'solid'),
        size: coerceTLSize(props.size, 'm'),
        font: coerceTLFont(props.font, 'draw'),
        align: coerceAlign(props.align, 'middle'),
        verticalAlign: coerceVerticalAlign(props.verticalAlign, 'middle'),
        richText: coerceRichText(props.richText),
        labelColor: coerceTLColor(props.labelColor, 'black'),
        url: typeof props.url === 'string' ? props.url : '',
        growY: coerceNumber(props.growY, 0),
        scale: coerceNumber(props.scale, 1),
      }
    }

    if (type === 'arrow') {
      const kindRaw = props.kind
      const kind = kindRaw === 'straight' ? 'arc' : isOneOf(kindRaw, ['arc', 'elbow'] as const) ? kindRaw : 'arc'
      const start = props.start && typeof props.start === 'object' ? props.start : {}
      const end = props.end && typeof props.end === 'object' ? props.end : {}
      return {
        kind,
        start: { x: coerceNumber(start.x, 0), y: coerceNumber(start.y, 0) },
        end: { x: coerceNumber(end.x, 100), y: coerceNumber(end.y, 0) },
        bend: coerceNumber(props.bend, 0),
        color: coerceTLColor(props.color, 'black'),
        fill: coerceTLFill(props.fill, 'none'),
        dash: coerceTLDash(props.dash, 'solid'),
        size: coerceTLSize(props.size, 'm'),
        font: coerceTLFont(props.font, 'draw'),
        arrowheadStart: typeof props.arrowheadStart === 'string' ? props.arrowheadStart : 'none',
        arrowheadEnd: typeof props.arrowheadEnd === 'string' ? props.arrowheadEnd : 'arrow',
        labelColor: coerceTLColor(props.labelColor, 'black'),
        labelPosition: coerceNumber(props.labelPosition, 0.5),
        richText: coerceRichText(props.richText),
        scale: coerceNumber(props.scale, 1),
        elbowMidPoint: coerceNumber(props.elbowMidPoint, 0.5),
      }
    }

    if (type === 'note') {
      return {
        color: coerceTLColor(props.color, 'yellow'),
        labelColor: coerceTLColor(props.labelColor, 'black'),
        size: coerceTLSize(props.size, 'm'),
        font: coerceTLFont(props.font, 'draw'),
        fontSizeAdjustment: coerceNumber(props.fontSizeAdjustment, 0),
        align: coerceAlign(props.align, 'middle'),
        verticalAlign: coerceVerticalAlign(props.verticalAlign, 'middle'),
        growY: coerceNumber(props.growY, 0),
        url: typeof props.url === 'string' ? props.url : '',
        richText: coerceRichText(props.richText),
        scale: coerceNumber(props.scale, 1),
      }
    }

    if (type === 'text') {
      return {
        color: coerceTLColor(props.color, 'black'),
        size: coerceTLSize(props.size, 'm'),
        font: coerceTLFont(props.font, 'draw'),
        textAlign: coerceAlign(props.textAlign, 'start'),
        w: coerceNumber(props.w, 200),
        richText: coerceRichText(props.richText),
        scale: coerceNumber(props.scale, 1),
        autoSize: typeof props.autoSize === 'boolean' ? props.autoSize : true,
      }
    }

    if (type === 'frame') {
      return {
        w: coerceNumber(props.w, 400),
        h: coerceNumber(props.h, 300),
        name: typeof props.name === 'string' ? props.name : '',
        color: coerceTLColor(props.color, 'black'),
      }
    }

    if (type === 'line') {
      return {
        color: coerceTLColor(props.color, 'black'),
        dash: coerceTLDash(props.dash, 'solid'),
        size: coerceTLSize(props.size, 'm'),
        spline: typeof props.spline === 'string' ? props.spline : 'line',
        points: props.points && typeof props.points === 'object' ? props.points : {},
        scale: coerceNumber(props.scale, 1),
      }
    }

    if (type === 'draw') {
      return {
        color: coerceTLColor(props.color, 'black'),
        fill: coerceTLFill(props.fill, 'none'),
        dash: coerceTLDash(props.dash, 'solid'),
        size: coerceTLSize(props.size, 'm'),
        segments: Array.isArray(props.segments) ? props.segments : [],
        isComplete: typeof props.isComplete === 'boolean' ? props.isComplete : true,
        isClosed: typeof props.isClosed === 'boolean' ? props.isClosed : false,
        isPen: typeof props.isPen === 'boolean' ? props.isPen : false,
        scale: coerceNumber(props.scale, 1),
        scaleX: coerceNumber(props.scaleX, 1),
        scaleY: coerceNumber(props.scaleY, 1),
      }
    }

    if (type === 'group') {
      return {}
    }

    return props
  }

  useEffect(() => {
    // Ensure active agent exists.
    if (agents.length === 0) return
    if (agents.some((a) => a.id === activeAgentId)) return
    setActiveAgentId(agents.some((a) => a.id === systemAgentId) ? systemAgentId : (agents[0]?.id ?? systemAgentId))
  }, [agents, activeAgentId])

  const toCanvasShape = (record: any): CanvasShape => {
    const { typeName, ...rest } = record ?? {}
    return normalizeCanvasShape(rest)
  }

  const normalizeCanvasShape = (shape: any): CanvasShape => {
    const props = shape?.props && typeof shape.props === 'object' ? shape.props : {}
    const meta = shape?.meta && typeof shape.meta === 'object' ? shape.meta : {}
    const type = typeof shape?.type === 'string' ? shape.type : 'note'
    return {
      id: typeof shape?.id === 'string' ? shape.id : '',
      type,
      x: typeof shape?.x === 'number' ? shape.x : 0,
      y: typeof shape?.y === 'number' ? shape.y : 0,
      rotation: typeof shape?.rotation === 'number' ? shape.rotation : 0,
      index: coerceIndexKey(shape?.index),
      parentId: typeof shape?.parentId === 'string' ? shape.parentId : 'page:page',
      isLocked: typeof shape?.isLocked === 'boolean' ? shape.isLocked : false,
      opacity: typeof shape?.opacity === 'number' ? shape.opacity : 1,
      meta,
      props: sanitizePropsByType(type, props),
    } as CanvasShape
  }

  const toTLShapeRecord = (shape: CanvasShape): any => {
    return { ...normalizeCanvasShape(shape), typeName: 'shape' }
  }

  const isShapeRecord = (record: any): boolean => {
    return (
      !!record &&
      typeof record === 'object' &&
      record.typeName === 'shape' &&
      typeof record.id === 'string' &&
      record.id.startsWith('shape:')
    )
  }

  const shouldTriggerAutocompleteFromDiff = (diff: RecordsDiff<UnknownRecord>): boolean => {
    const hasShapeUpdate = Object.values(diff.updated as any).some((pair: any) => {
      const rec = Array.isArray(pair) ? pair[1] : pair?.after ?? pair?.next ?? pair?.to ?? null
      return !!rec && typeof rec.id === 'string' && rec.id.startsWith('shape:') && !rec?.meta?.ghost
    })
    if (hasShapeUpdate) return true

    // Also allow new shape additions by user interactions (draw/create on canvas).
    const hasShapeAdd = Object.values(diff.added as any).some((rec: any) => {
      return !!rec && typeof rec.id === 'string' && rec.id.startsWith('shape:') && !rec?.meta?.ghost
    })
    return hasShapeAdd
  }

  const syncEditorDiffToStorage = useMutation(({ storage }, diff: RecordsDiff<UnknownRecord>) => {
    const shapes = storage.get('shapes')
    const allowed = new Set(['geo', 'arrow', 'note', 'text', 'frame', 'line', 'draw', 'group'])

    for (const rec of Object.values(diff.added as any) as any[]) {
      if (!isShapeRecord(rec)) continue
      if (rec?.meta?.ghost) continue
      if (!allowed.has(String(rec.type))) continue
      shapes.set(String(rec.id), toCanvasShape(rec))
    }

    for (const pair of Object.values(diff.updated as any) as any[]) {
      const rec = Array.isArray(pair) ? pair[1] : undefined
      if (!isShapeRecord(rec)) continue
      if ((rec as any)?.meta?.ghost) continue
      if (!allowed.has(String((rec as any).type))) continue
      shapes.set(String((rec as any).id), toCanvasShape(rec))
    }

    for (const id of Object.keys(diff.removed as any)) {
      if (typeof id !== 'string' || !id.startsWith('shape:')) continue
      shapes.delete(id)
    }
  }, [])

  const putPendingChange = useMutation(({ storage }, change: PendingChange) => {
    storage.get('pendingChanges').set(change.id, change)
  }, [])

  const deletePendingChange = useMutation(({ storage }, changeId: string) => {
    storage.get('pendingChanges').delete(changeId)
  }, [])

  const acquireAutocompleteLease = useMutation(
    ({ storage }, ownerId: string) => {
      const now = Date.now()
      const meta = storage.get('meta')
      const current = (meta.get('autocompleteLease') as RoomMeta['autocompleteLease']) ?? null
      const canTake =
        !current ||
        !current.ownerId ||
        typeof current.expiresAt !== 'number' ||
        current.expiresAt <= now ||
        current.ownerId === ownerId

      if (!canTake) return false

      meta.set('autocompleteLease', {
        ownerId,
        expiresAt: now + AUTOCOMPLETE_LEASE_TTL_MS,
      })
      return true
    },
    [AUTOCOMPLETE_LEASE_TTL_MS],
  )

  const releaseAutocompleteLease = useMutation(
    ({ storage }, ownerId: string) => {
      const meta = storage.get('meta')
      const current = (meta.get('autocompleteLease') as RoomMeta['autocompleteLease']) ?? null
      if (current?.ownerId !== ownerId) return
      meta.set('autocompleteLease', null)
    },
    [],
  )

	  const upsertAgentWithChat = useMutation(
	    (
	      { storage },
	      params: { agent: AgentInfo; initialMessage?: Omit<AgentChatMessage, 'agentId'> },
	    ) => {
	      storage.get('agents').set(params.agent.id, params.agent)
	      const chats =
	        storage.get('agentChats') ??
	        (() => {
	          const created = new LiveMap<string, LiveList<AgentChatMessage>>()
	          storage.set('agentChats', created as any)
	          return created
	        })()
      if (!chats.get(params.agent.id)) {
        const initial =
          params.initialMessage ??
          ({
            id: `msg_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`,
            role: 'agent',
            authorKey: params.agent.id,
            authorName: params.agent.name,
            content: `Hi, I am ${params.agent.name}. What should I do?`,
            createdAt: new Date().toISOString(),
          } satisfies Omit<AgentChatMessage, 'agentId'>)
        chats.set(params.agent.id, new LiveList<AgentChatMessage>([{ ...initial, agentId: params.agent.id }]))
      }
    },
    [],
  )

	  const migrateSystemAgent = useMutation(
	    ({ storage }, params: { fromId: string; toId: string; name: string }) => {
	      const agentsMap = storage.get('agents')
	      agentsMap.set(params.toId, { id: params.toId, name: params.name })
	      if (params.fromId !== params.toId && agentsMap.get(params.fromId)) agentsMap.delete(params.fromId)

	      const chats = storage.get('agentChats')
	      if (chats) {
        const fromChat = chats.get(params.fromId)
        const toChat = chats.get(params.toId)
        if (!toChat) {
          if (fromChat) chats.set(params.toId, fromChat)
          else chats.set(params.toId, new LiveList<AgentChatMessage>([]))
        }
        if (params.fromId !== params.toId && fromChat) chats.delete(params.fromId)
      }
    },
    [],
  )

	  const removeAgentFromStorage = useMutation(({ storage }, agentId: string) => {
	    storage.get('agents').delete(agentId)
	    const chats = storage.get('agentChats')
	    chats?.delete(agentId)
	  }, [])

  const appendChatMessage = useMutation(({ storage }, message: AgentChatMessage) => {
    const chats =
      storage.get('agentChats') ??
      (() => {
        const created = new LiveMap<string, LiveList<AgentChatMessage>>()
        storage.set('agentChats', created as any)
        return created
      })()
    const list =
      chats.get(message.agentId) ??
      (() => {
        const created = new LiveList<AgentChatMessage>([])
        chats.set(message.agentId, created)
        return created
      })()
    list.push(message)
  }, [])

	  const upsertAgentsFromApi = useMutation(({ storage }, agentsFromApi: Array<{ id: string; name: string }>) => {
	    const agentsMap = storage.get('agents')
	    for (const a of agentsFromApi) {
	      agentsMap.set(a.id, { id: a.id, name: a.name })
	    }
	  }, [])

  const setAgentChatIfEmpty = useMutation(
    (
      { storage },
      params: { agentId: string; messages: AgentChatMessage[] },
    ) => {
      const chats =
        storage.get('agentChats') ??
        (() => {
          const created = new LiveMap<string, LiveList<AgentChatMessage>>()
          storage.set('agentChats', created as any)
          return created
        })()

      const existing = chats.get(params.agentId)
      if (existing && existing.length > 0) return
      chats.set(params.agentId, new LiveList<AgentChatMessage>(params.messages))
    },
    [],
  )

  const ensureAgentChatsInitialized = useMutation(({ storage }) => {
    const chats =
      storage.get('agentChats') ??
      (() => {
        const created = new LiveMap<string, LiveList<AgentChatMessage>>()
        storage.set('agentChats', created as any)
        return created
      })()

    if (!chats.get('agent-0')) {
      chats.set(
        'agent-0',
        new LiveList<AgentChatMessage>([]),
      )
    }
  }, [])

  useEffect(() => {
    if (!isStorageLoaded) return
    ensureAgentChatsInitialized()
  }, [ensureAgentChatsInitialized, isStorageLoaded])

  useEffect(() => {
    if (!isStorageLoaded) return
    if (!agentApiEnabled()) return
    if (didBootstrapAgentsRef.current) return

    didBootstrapAgentsRef.current = true

    ;(async () => {
      try {
        const res = await apiListAgents(roomId)
        const defaultAgent = res.agents.find((a) => a.is_default) ?? null
        if (defaultAgent?.id) {
          defaultBackendAgentIdRef.current = defaultAgent.id
          const nextSystemId = defaultAgent.id
          setSystemAgentId(nextSystemId)
          migrateSystemAgent({
            fromId: 'agent-0',
            toId: nextSystemId,
            name: 'System',
          })
          setActiveAgentId((cur) => (cur === 'agent-0' ? nextSystemId : cur))
        }

        // Ensure system agent key exists locally for UI expectations.
        const normalized = res.agents.map((a) => {
          if (a.is_default) return { id: defaultAgent?.id ?? a.id, name: 'System' }
          return { id: a.id, name: a.name }
        })
        upsertAgentsFromApi(normalized)
      } catch (e) {
        console.warn('Failed to bootstrap agents from API:', e)
      }
    })()
  }, [isStorageLoaded, migrateSystemAgent, roomId, upsertAgentsFromApi])

  useEffect(() => {
    if (!isStorageLoaded) return
    if (!agentApiEnabled()) return

    const localId = activeAgentId
    if (didLoadMessagesRef.current.has(localId)) return
    didLoadMessagesRef.current.add(localId)

    const backendId = toBackendAgentId(localId)
    ;(async () => {
      try {
        const res = await apiGetAgentMessages({ agentId: backendId, limit: 50, offset: 0 })
        const mapped: AgentChatMessage[] = res.messages.map((m) => {
          if ((m as any).type === 'change') {
            const ch = m as any
	            return {
	              id: String(ch.id),
	              agentId: localId,
	              role: 'agent',
	              authorKey: localId,
		              authorName: displayChatAgentName(localId),
	              content: String(ch.operations_summary ?? 'Change'),
	              createdAt: String(ch.created_at ?? new Date().toISOString()),
	            }
	          }
          const t = m as any
          const role = t.role === 'assistant' ? 'agent' : 'user'
          return {
            id: String(t.id),
            agentId: localId,
            role,
            authorKey: role === 'agent' ? localId : String(self?.id ?? 'self'),
		            authorName:
		              role === 'agent'
		                ? displayChatAgentName(localId)
		                : typeof self?.presence?.name === 'string' && self.presence.name.trim()
		                  ? self.presence.name.trim()
                  : 'User',
            content: String(t.content ?? ''),
            createdAt: String(t.created_at ?? new Date().toISOString()),
          }
        })
        setAgentChatIfEmpty({ agentId: localId, messages: mapped })
      } catch (e) {
        console.warn('Failed to load agent messages:', e)
      }
    })()
  }, [activeAgentId, agents, isStorageLoaded, self?.id, self?.presence?.name, setAgentChatIfEmpty])

  const splitPendingOperations = (change: PendingChange) => {
    const addNodeOps = change.operations.filter(
      (op) => op.op === 'add_shape' && op.shape && op.shape.type !== 'arrow',
    )
    const addArrowOps = change.operations.filter(
      (op) => op.op === 'add_shape' && op.shape && op.shape.type === 'arrow',
    )
    const updateOps = change.operations.filter((op) => op.op === 'update_shape' && op.shapeId && op.updates)
    const deleteOps = change.operations.filter((op) => op.op === 'delete_shape' && op.shapeId)
    return { addNodeOps, addArrowOps, updateOps, deleteOps }
  }

  type AgentConnectionTerminal = {
    shapeId: string
    normalizedAnchor?: { x: number; y: number }
    isExact?: boolean
    isPrecise?: boolean
    snap?: 'center' | 'edge-point' | 'edge' | 'none'
  }

  const parseAgentConnectionTerminal = (raw: any): AgentConnectionTerminal | null => {
    if (!raw || typeof raw !== 'object') return null
    const shapeId =
      typeof raw.shapeId === 'string'
        ? raw.shapeId
        : typeof raw.toShapeId === 'string'
          ? raw.toShapeId
          : typeof raw.id === 'string'
            ? raw.id
            : null
    if (!shapeId) return null
    const anchor =
      raw.normalizedAnchor && typeof raw.normalizedAnchor === 'object'
        ? {
            x: typeof raw.normalizedAnchor.x === 'number' ? raw.normalizedAnchor.x : 0.5,
            y: typeof raw.normalizedAnchor.y === 'number' ? raw.normalizedAnchor.y : 0.5,
          }
        : undefined
    const snap =
      raw.snap === 'center' || raw.snap === 'edge-point' || raw.snap === 'edge' || raw.snap === 'none'
        ? raw.snap
        : undefined
    return {
      shapeId,
      normalizedAnchor: anchor,
      isExact: typeof raw.isExact === 'boolean' ? raw.isExact : undefined,
      isPrecise: typeof raw.isPrecise === 'boolean' ? raw.isPrecise : undefined,
      snap,
    }
  }

  const getArrowBindingTerminalFromMeta = (
    meta: any,
    terminal: 'start' | 'end',
  ): AgentConnectionTerminal | null => {
    if (!meta || typeof meta !== 'object') return null
    const conn = meta.agentConnection
    if (!conn || typeof conn !== 'object') return null

    const direct = parseAgentConnectionTerminal(conn[terminal])
    if (direct) return direct

    if (terminal === 'start') {
      return parseAgentConnectionTerminal({
        shapeId: conn.startShapeId ?? conn.sourceId ?? conn.fromId,
        normalizedAnchor: conn.startNormalizedAnchor,
        isExact: conn.startIsExact,
        isPrecise: conn.startIsPrecise,
        snap: conn.startSnap,
      })
    }

    return parseAgentConnectionTerminal({
      shapeId: conn.endShapeId ?? conn.targetId ?? conn.toId,
      normalizedAnchor: conn.endNormalizedAnchor,
      isExact: conn.endIsExact,
      isPrecise: conn.endIsPrecise,
      snap: conn.endSnap,
    })
  }

  const createArrowBindingsFromMeta = (editor: Editor, arrowShape: CanvasShape) => {
    if (arrowShape.type !== 'arrow') return
    const start = getArrowBindingTerminalFromMeta(arrowShape.meta, 'start')
    const end = getArrowBindingTerminalFromMeta(arrowShape.meta, 'end')
    if (!start && !end) return

    const tryCreate = () => {
      const arrowId = String(arrowShape.id)
      if (!editor.getShape(arrowId as any)) return false

      const bindingPartials: any[] = []
      const buildPartial = (terminal: 'start' | 'end', config: AgentConnectionTerminal | null) => {
        if (!config) return
        const toId = String(config.shapeId)
        if (!editor.getShape(toId as any)) return
        bindingPartials.push({
          type: 'arrow',
          fromId: arrowId,
          toId,
          props: {
            terminal,
            normalizedAnchor: config.normalizedAnchor ?? { x: 0.5, y: 0.5 },
            isExact: config.isExact ?? false,
            isPrecise: config.isPrecise ?? true,
            snap: config.snap ?? 'edge',
          },
        })
      }

      buildPartial('start', start)
      buildPartial('end', end)

      if (bindingPartials.length === 0) return false
      const existing = editor.getBindingsFromShape(arrowId as any, 'arrow')
      if (existing.length > 0) editor.deleteBindings(existing as any)
      editor.createBindings(bindingPartials)
      return true
    }

    if (tryCreate()) return
    // Delay once to allow referenced shapes to land in editor state.
    window.setTimeout(() => {
      tryCreate()
    }, 120)
  }

  const applyPendingOperationsToEditor = (editor: Editor, change: PendingChange) => {
    const { addNodeOps, addArrowOps, updateOps, deleteOps } = splitPendingOperations(change)

    const nodeCreates = addNodeOps
      .map((op) => op.shape)
      .filter(Boolean)
      .map((shape) =>
        normalizeCanvasShape({
          ...shape!,
          opacity: 1,
          isLocked: false,
          meta: {
            ...(shape!.meta ?? {}),
          },
        }),
      )
    const arrowCreates = addArrowOps
      .map((op) => op.shape)
      .filter(Boolean)
      .map((shape) =>
        normalizeCanvasShape({
          ...shape!,
          opacity: 1,
          isLocked: false,
          meta: {
            ...(shape!.meta ?? {}),
          },
        }),
      )

    if (nodeCreates.length > 0) editor.createShapes(nodeCreates as any)
    if (arrowCreates.length > 0) editor.createShapes(arrowCreates as any)

    for (const op of updateOps) {
      const shapeId = String(op.shapeId)
      const current = editor.getShape(shapeId as any)
      if (!current) continue
      const next: any = { ...current, ...(op.updates as any) }
      if (op.updates && op.updates.props && typeof op.updates.props === 'object') {
        next.props = { ...(current as any).props, ...(op.updates as any).props }
      }
      if (op.updates && op.updates.meta && typeof op.updates.meta === 'object') {
        next.meta = { ...(current as any).meta, ...(op.updates as any).meta }
      }
      editor.updateShape(next)
    }

    for (const arrow of arrowCreates) createArrowBindingsFromMeta(editor, arrow)

    if (deleteOps.length > 0) {
      editor.deleteShapes(deleteOps.map((op) => String(op.shapeId)) as any)
    }
  }

  const applyPendingOperationsToStorage = useMutation(({ storage }, change: PendingChange) => {
    const shapes = storage.get('shapes')
    const { addNodeOps, addArrowOps, updateOps, deleteOps } = splitPendingOperations(change)

    const commitAddedShape = (shape: CanvasShape) => {
      const meta: any = { ...(shape.meta ?? {}) }
      delete meta.isPending
      delete meta.pendingChangeId
      delete meta.requestedByColor
      // Important: preserve `meta.agentConnection` for arrow binding recreation in approve flow.
      const committed = normalizeCanvasShape({
        ...shape,
        opacity: 1,
        isLocked: false,
        meta,
      })
      shapes.set(committed.id, committed)
    }

    for (const op of addNodeOps) {
      if (op.op === 'add_shape' && op.shape) commitAddedShape(op.shape)
    }
    for (const op of addArrowOps) {
      if (op.op === 'add_shape' && op.shape) commitAddedShape(op.shape)
    }
    for (const op of updateOps) {
      if (op.op !== 'update_shape' || !op.shapeId || !op.updates) continue
      const current = shapes.get(op.shapeId)
      if (!current) continue
      const next: any = { ...current, ...op.updates }
      if (op.updates.props && typeof op.updates.props === 'object') {
        next.props = { ...(current as any).props, ...(op.updates as any).props }
      }
      if (op.updates.meta && typeof op.updates.meta === 'object') {
        next.meta = { ...(current as any).meta, ...(op.updates as any).meta }
      }
      if (!next.meta || typeof next.meta !== 'object') next.meta = {}
      delete next.meta.isPending
      delete next.meta.pendingChangeId
      delete next.meta.requestedByColor
      next.opacity = 1
      shapes.set(op.shapeId, normalizeCanvasShape(next))
    }
    for (const op of deleteOps) {
      if (op.op === 'delete_shape' && op.shapeId) shapes.delete(op.shapeId)
    }

    storage.get('pendingChanges').delete(change.id)
  }, [])

  const appliedShapesRef = useRef<Map<string, string>>(new Map())
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    if (syncStatus !== 'synchronized') return
    if (!shapesMap) return

    const nextEntries = Array.from(shapesMap.entries())
    const nextSerialized = new Map<string, string>()
    for (const [id, shape] of nextEntries) {
      nextSerialized.set(id, JSON.stringify(shape))
    }

    const prev = appliedShapesRef.current
    const toPut: any[] = []
    const toRemove: string[] = []

    for (const [id, serialized] of nextSerialized) {
      if (prev.get(id) !== serialized) {
        const shape = shapesMap.get(id)
        if (shape) toPut.push(toTLShapeRecord(shape))
      }
    }
    for (const id of prev.keys()) {
      if (!nextSerialized.has(id)) toRemove.push(id)
    }

    if (toPut.length === 0 && toRemove.length === 0) return

    editor.store.mergeRemoteChanges(() => {
      if (toPut.length > 0) editor.store.put(toPut)
      if (toRemove.length > 0) editor.store.remove(toRemove as any)
    })

    // Recreate arrow bindings from persisted shape metadata on every client.
    // This keeps attachments consistent for concurrent viewers, not only the approver tab.
    for (const shape of shapesMap.values()) {
      if (shape.type !== 'arrow') continue
      createArrowBindingsFromMeta(editor, shape)
    }

    appliedShapesRef.current = nextSerialized
  }, [shapesMap, syncStatus])

  const ghostShapeIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    if (syncStatus !== 'synchronized') return
    if (!shapesMap) return

    const desired = new Map<string, any>()
    for (const chg of pendingChanges) {
      const requestedByColor =
        typeof chg.requestedByColor === 'string' && chg.requestedByColor.trim()
          ? chg.requestedByColor.trim()
          : '#8B5CF6'
      for (const op of chg.operations) {
        const baseShape =
          op.op === 'add_shape' && op.shape
            ? op.shape
            : op.op === 'update_shape' && op.shapeId && op.updates
              ? (() => {
                  const current = shapesMap.get(op.shapeId)
                  if (!current) return null
                  const next: any = { ...current, ...op.updates }
                  if (op.updates.props && typeof op.updates.props === 'object') {
                    next.props = { ...(current as any).props, ...(op.updates as any).props }
                  }
                  if (op.updates.meta && typeof op.updates.meta === 'object') {
                    next.meta = { ...(current as any).meta, ...(op.updates as any).meta }
                  }
                  return next as CanvasShape
                })()
              : null

        if (!baseShape) continue
        if (!['geo', 'arrow', 'note', 'text', 'frame', 'line', 'draw', 'group'].includes(baseShape.type))
          continue

        const baseId = String((op.op === 'update_shape' ? op.shapeId : baseShape.id) ?? '').replace(/^shape:/, '')
        const ghostId = `shape:ghost-${chg.id}-${baseId}`
        const ghostShapeBase = normalizeCanvasShape({
          ...baseShape,
          id: ghostId,
          opacity: 0.35,
          isLocked: true,
          meta: {
            ...(baseShape.meta ?? {}),
            ghost: true,
            isPending: true,
            pendingChangeId: chg.id,
            requestedByColor,
          },
        })
        const ghostProps: any =
          ghostShapeBase.props && typeof ghostShapeBase.props === 'object' ? { ...(ghostShapeBase.props as any) } : ghostShapeBase.props
        const tlColor = tlColorFromUserColor(requestedByColor)
        if (ghostProps && typeof ghostProps === 'object') {
          if ('color' in ghostProps) ghostProps.color = tlColor
          if ('labelColor' in ghostProps) ghostProps.labelColor = tlColor
          if ('dash' in ghostProps) ghostProps.dash = 'dashed'
        }
        const ghostShape = {
          ...ghostShapeBase,
          props: ghostProps,
        } as CanvasShape
        desired.set(ghostId, ghostShape)
      }
    }

    const existing = ghostShapeIdsRef.current
    const toRemove: string[] = []
    for (const id of existing) {
      if (!desired.has(id)) toRemove.push(id)
    }

    const toPut: any[] = []
    for (const [id, ghost] of desired) {
      existing.add(id)
      toPut.push(toTLShapeRecord(ghost as CanvasShape))
    }

    if (toPut.length === 0 && toRemove.length === 0) return

    try {
      editor.store.mergeRemoteChanges(() => {
        if (toPut.length > 0) editor.store.put(toPut)
        if (toRemove.length > 0) editor.store.remove(toRemove as any)
      })
    } catch (e) {
      console.error('Failed to apply ghost shapes:', e)
    }

    for (const id of toRemove) existing.delete(id)
  }, [pendingChanges, syncStatus, shapesMap])

  const scheduleAutocomplete = () => {
    const editor = editorRef.current
    if (!editor) return
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current)

    idleTimerRef.current = setTimeout(async () => {
      const editorNow = editorRef.current
      if (!editorNow) return
      if (!isStorageLoaded) return
      if (isThinkingRef.current) return
      const autocompleteOwnerId = autocompleteOwnerIdRef.current
      const awaiting = awaitingBackendChangeRef.current
      if (awaiting) {
        if (Date.now() - awaiting.requestedAt <= AWAITING_BACKEND_TTL_MS) return
        setAwaitingBackendChange((current) => (current?.id === awaiting.id ? null : current))
      }
      if (pendingChangesRef.current.some((c) => c.status === 'pending')) return
      if (!acquireAutocompleteLease(autocompleteOwnerId)) return

      const snapshot = buildSnapshot(editorNow)

      isThinkingRef.current = true
      setIsThinkingUi(true)
      lastAutocompleteRef.current = Date.now()
      try {
        const res = await autocomplete({
          contractVersion: BRAINSTORM_CONTRACT_VERSION,
          roomId,
          snapshot,
          maxNewShapes: 2,
        })
        if (res.commands.length > 0) {
          const changeId = `chg_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`
          const now = new Date().toISOString()
          const operations: PendingChange['operations'] = res.commands.map((cmd, idx) => {
            if (cmd.action === 'create' && cmd.shapeType === 'note') {
              const id = toShapeId(cmd.id)
              const shape: CanvasShape = {
                id: String(id),
                type: 'note',
                x: cmd.x,
                y: cmd.y,
                rotation: 0,
                index: nextIndexKey(),
                parentId: 'page:page',
                isLocked: false,
                opacity: 1,
                meta: {},
                props: {
                  color: 'yellow',
                  labelColor: 'black',
                  size: 'm',
                  font: 'draw',
                  fontSizeAdjustment: 0,
                  align: 'middle',
                  verticalAlign: 'middle',
                  growY: 0,
                  url: '',
                  richText: toRichText(cmd.text),
                  scale: 1,
                },
              }
              return { op: 'add_shape', shape }
            }
            if (cmd.action === 'update') {
              const shapeId = String(toShapeId(cmd.id))
              const updates: Record<string, any> = {}
              if (cmd.x !== undefined) updates.x = cmd.x
              if (cmd.y !== undefined) updates.y = cmd.y
              if (cmd.text !== undefined) updates.props = { richText: toRichText(cmd.text) }
              return { op: 'update_shape', shapeId, updates }
            }
            if (cmd.action === 'delete') {
              const shapeId = String(toShapeId(cmd.id))
              return { op: 'delete_shape', shapeId }
            }
            return { op: 'delete_shape', shapeId: String(toShapeId(cmd.id)) }
          })
          putPendingChange({
            id: changeId,
            agentId: systemAgentId,
            status: 'pending',
            requestedByColor:
              typeof self?.presence?.color === 'string' && self.presence.color.trim()
                ? self.presence.color.trim()
                : undefined,
            operations,
            reasoning: '',
            createdAt: now,
          })
        } else if (res.changeId) {
          // Backend mode: /complete returns a changeId and the backend is expected to write the
          // full PendingChange (with operations) into Liveblocks `pendingChanges`.
          // Do NOT overwrite it client-side; just remember we're waiting.
          setAwaitingBackendChange({
            id: res.changeId,
            operationsCount: res.operationsCount ?? 0,
            reasoning: res.reasoning ?? '',
            requestedAt: Date.now(),
          })
          // Do not write system chat messages here; system chat is reserved for user [edit] prompts.
        }
      } catch (e: any) {
        console.warn('Autocomplete failed:', e)
      } finally {
        releaseAutocompleteLease(autocompleteOwnerId)
        isThinkingRef.current = false
        setIsThinkingUi(false)
      }
    }, 2000)
  }

  const runAutocompleteWithHint = async (hint: string) => {
    const editorNow = editorRef.current
    if (!editorNow) return
    if (!isStorageLoaded) return
    if (isThinkingRef.current) return

    const snapshot = buildSnapshot(editorNow)
    isThinkingRef.current = true
    setIsThinkingUi(true)
    lastAutocompleteRef.current = Date.now()
    try {
      const res = await autocomplete({
        contractVersion: BRAINSTORM_CONTRACT_VERSION,
        roomId,
        snapshot,
        hint,
        maxNewShapes: 2,
      })
      if (res.commands.length > 0) {
        suppressAutocompleteUntilRef.current = Date.now() + 4_000
        applyCommandsToEditor(editorNow, res.commands)
      } else if (res.changeId) {
        setAwaitingBackendChange({
          id: res.changeId,
          operationsCount: res.operationsCount ?? 0,
          reasoning: res.reasoning ?? '',
          requestedAt: Date.now(),
        })
        // Do not write system chat messages here; system chat is reserved for user [edit] prompts.
      }
    } catch (e: any) {
      console.warn('Checkpoint autocomplete failed:', e)
    } finally {
      isThinkingRef.current = false
      setIsThinkingUi(false)
    }
  }

  const onMount = (editor: Editor) => {
    editorRef.current = editor
    editor.user.updateUserPreferences({ areKeyboardShortcutsEnabled: true })
    editor.focus()

    const unsubscribe = editor.store.listen(
      (entry) => {
        syncEditorDiffToStorage(entry.changes as RecordsDiff<UnknownRecord>)
        if (Date.now() < suppressAutocompleteUntilRef.current) return
        if (shouldTriggerAutocompleteFromDiff(entry.changes as RecordsDiff<UnknownRecord>)) {
          scheduleAutocomplete()
        }
      },
      { source: 'user', scope: 'document' },
    )

    return () => {
      unsubscribe()
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
      idleTimerRef.current = null
    }
  }

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false
      const tag = target.tagName.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
      if (target.isContentEditable) return true
      return false
    }

    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null
      const editable = isEditableTarget(target)
      const insideCanvas = !!(target && canvasHostRef.current?.contains(target))
      if (editable && !insideCanvas) return
      const editor = editorRef.current
      if (!editor) return

      const accel = e.metaKey || e.ctrlKey
      if (!accel) return
      const key = e.key.toLowerCase()
      const code = e.code

      const isCopy = key === 'c' || code === 'KeyC'
      const isCut = key === 'x' || code === 'KeyX'
      const isPaste = key === 'v' || code === 'KeyV'

      if (isCopy || isCut) {
        const selected = editor.getSelectedShapeIds()
        if (selected.length === 0) return
        const content = editor.getContentFromCurrentPage(selected as any)
        if (!content) return
        localClipboardRef.current = content
        if (isCut) {
          editor.deleteShapes(selected as any)
        }
        e.preventDefault()
        e.stopPropagation()
        return
      }

      if (isPaste) {
        if (!localClipboardRef.current) return
        e.preventDefault()
        e.stopPropagation()
        editor.putContentOntoCurrentPage(localClipboardRef.current, {
          preserveIds: false,
          preservePosition: false,
          select: true,
        } as any)
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  // Live cursors via Liveblocks presence.
  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const now = Date.now()
    if (now - lastCursorSentAtRef.current < 33) return
    lastCursorSentAtRef.current = now
    updateMyPresence({ cursor: { x: Math.round(e.clientX), y: Math.round(e.clientY) } })
  }

  const handlePointerLeave = () => {
    updateMyPresence({ cursor: null })
  }

  const focusChatInput = () => {
    setTimeout(() => {
      chatInputRef.current?.focus()
    }, 0)
  }

  const copyInviteLink = async () => {
    try {
      const url = new URL(window.location.href)
      const finalUrl = inviteFrontendHost ? applyFrontendHostToUrl(url, inviteFrontendHost) : url
      const ok = await copyText(finalUrl.toString())
      setCopyStatus(ok ? 'copied' : 'failed')
      window.setTimeout(() => setCopyStatus('idle'), 1800)
    } catch {
      setCopyStatus('failed')
      window.setTimeout(() => setCopyStatus('idle'), 1800)
    }
  }

  const applySlashCommand = (command: string) => {
    setChatInputValue(`${command} `)
    setSlashMenuDismissed(true)
    setSlashMenuIndex(0)
    focusChatInput()
  }

  const isAgent0 = (agentId: string) =>
    agentId === 'agent-0' || agentId.startsWith('agent_0') || agentId.startsWith('agent0')

  const displayAgentName = (agentId: string) => {
    if (agentId === systemAgentId || isAgent0(agentId)) return 'System'
    return agents.find((a) => a.id === agentId)?.name ?? 'Agent'
  }

  const displayChatAgentName = (agentId: string) => {
    if (agentId === systemAgentId || isAgent0(agentId)) return 'System'
    return agents.find((a) => a.id === agentId)?.name ?? 'Agent'
  }

  const toBackendAgentId = (agentId: string) => {
    if (agentId === systemAgentId || isAgent0(agentId)) return defaultBackendAgentIdRef.current ?? agentId
    return agentId
  }

  const agent0Pending = useMemo(() => {
    return pendingChanges.filter((c) => isAgent0(String(c.agentId)) && c.status === 'pending')
  }, [pendingChanges])

  const pendingForActiveAgent = useMemo(() => {
    const localId = activeAgentId
    const backendId = toBackendAgentId(localId)
    return pendingChanges.filter((c) => {
      const changeAgentId = String(c.agentId)
      if (localId === systemAgentId) return changeAgentId === backendId || isAgent0(changeAgentId)
      return changeAgentId === backendId
    })
  }, [activeAgentId, pendingChanges])

  const activePendingForActiveAgent = pendingForActiveAgent[0] ?? null
  const activePendingChange =
    agent0Pending[0] ??
    (awaitingBackendChange
      ? ({
          id: awaitingBackendChange.id,
          agentId: 'agent-0',
          status: 'pending',
          operations: [],
          reasoning: awaitingBackendChange.reasoning,
          createdAt: new Date().toISOString(),
        } satisfies PendingChange)
      : null)
  const [editingChangeId, setEditingChangeId] = useState<string | null>(null)
  const requestedByColorForPill =
    (activePendingChange?.requestedByColor && activePendingChange.requestedByColor.trim()
      ? activePendingChange.requestedByColor.trim()
      : pendingChanges[0]?.requestedByColor && pendingChanges[0].requestedByColor.trim()
        ? pendingChanges[0].requestedByColor.trim()
        : '#8B5CF6') || '#8B5CF6'

  const clearAwaitingBackendChangeIfMatches = (changeId: string) => {
    setAwaitingBackendChange((cur) => (cur?.id === changeId ? null : cur))
  }

  const displayedPendingOperationsCount = !activePendingChange
    ? 0
    : activePendingChange.operations.length > 0
      ? activePendingChange.operations.length
      : (awaitingBackendChange?.id === activePendingChange.id
          ? awaitingBackendChange.operationsCount
          : 0) || 1

  const acceptPendingChange = async () => {
    if (!activePendingChange) return
    if (activePendingChange.operations.length > 0) {
      suppressAutocompleteUntilRef.current = Date.now() + 4_000
      const editor = editorRef.current
      if (editor) {
        const ghostIds = activePendingChange.operations
          .map((op) => {
            const baseId = String((op.op === 'update_shape' ? op.shapeId : op.shape?.id) ?? '')
              .replace(/^shape:/, '')
              .trim()
            if (!baseId) return null
            if (op.op !== 'add_shape' && op.op !== 'update_shape') return null
            return `shape:ghost-${activePendingChange.id}-${baseId}`
          })
          .filter(Boolean) as string[]
        if (ghostIds.length > 0) {
          editor.store.mergeRemoteChanges(() => {
            editor.store.remove(ghostIds as any)
          })
        }
        applyPendingOperationsToEditor(editor, activePendingChange)
      }
      applyPendingOperationsToStorage(activePendingChange)
      return
    }
    setIsThinkingUi(true)
    try {
      await completeAction({ roomId, changeId: activePendingChange.id, action: 'approve' })
      deletePendingChange(activePendingChange.id)
      clearAwaitingBackendChangeIfMatches(activePendingChange.id)
    } finally {
      setIsThinkingUi(false)
    }
  }

  const rejectPendingChange = async () => {
    if (!activePendingChange) return
    if (activePendingChange.operations.length > 0) {
      const editor = editorRef.current
      if (editor) {
        const ghostIds = activePendingChange.operations
          .map((op) => {
            const baseId = String((op.op === 'update_shape' ? op.shapeId : op.shape?.id) ?? '')
              .replace(/^shape:/, '')
              .trim()
            if (!baseId) return null
            if (op.op !== 'add_shape' && op.op !== 'update_shape') return null
            return `shape:ghost-${activePendingChange.id}-${baseId}`
          })
          .filter(Boolean) as string[]
        if (ghostIds.length > 0) {
          editor.store.mergeRemoteChanges(() => {
            editor.store.remove(ghostIds as any)
          })
        }
      }
      deletePendingChange(activePendingChange.id)
      return
    }
    setIsThinkingUi(true)
    try {
      await completeAction({ roomId, changeId: activePendingChange.id, action: 'reject' })
      deletePendingChange(activePendingChange.id)
      clearAwaitingBackendChangeIfMatches(activePendingChange.id)
    } finally {
      setIsThinkingUi(false)
    }
  }

  const acceptPendingChangeForAgent = async (change: PendingChange) => {
    if (!change) return
    if (change.operations.length > 0) {
      suppressAutocompleteUntilRef.current = Date.now() + 4_000
      const editor = editorRef.current
      if (editor) applyPendingOperationsToEditor(editor, change)
      applyPendingOperationsToStorage(change)
      return
    }
    setIsThinkingUi(true)
    try {
      await completeAction({ roomId, changeId: change.id, action: 'approve' })
      deletePendingChange(change.id)
      clearAwaitingBackendChangeIfMatches(change.id)
    } finally {
      setIsThinkingUi(false)
    }
  }

  const rejectPendingChangeForAgent = async (change: PendingChange) => {
    if (!change) return
    if (change.operations.length > 0) {
      deletePendingChange(change.id)
      return
    }
    setIsThinkingUi(true)
    try {
      await completeAction({ roomId, changeId: change.id, action: 'reject' })
      deletePendingChange(change.id)
      clearAwaitingBackendChangeIfMatches(change.id)
    } finally {
      setIsThinkingUi(false)
    }
  }

  const triggerEditFlowForChange = (change: PendingChange, seed?: string) => {
    if (!change) return
    setEditingChangeId(change.id)
    const changeAgentId = String(change.agentId)
    if (isAgent0(changeAgentId)) {
      setActiveAgentId('agent-0')
    } else {
      setActiveAgentId(changeAgentId)
    }
    const trimmedSeed = typeof seed === 'string' ? seed.trim() : ''
    setChatInputValue(trimmedSeed ? `[edit] ${trimmedSeed}` : '[edit] ')
    focusChatInput()
  }

  const triggerEditFlow = (seed?: string) => {
    if (activePendingChange) setEditingChangeId(activePendingChange.id)
    setActiveAgentId(systemAgentId)
    const trimmedSeed = typeof seed === 'string' ? seed.trim() : ''
    setChatInputValue(trimmedSeed ? `[edit] ${trimmedSeed}` : '[edit] ')
    focusChatInput()
  }

  const sendChatMessage = (content: string) => {
    const trimmed = content.trimEnd()
    if (!trimmed) return
    if (!isStorageLoaded) return
    const agentId = activeAgentId
    const trimmedStart = trimmed.trimStart()
    const isDeepResearchCommand = trimmedStart === '/deep-research' || trimmedStart.startsWith('/deep-research ')
    const isSkillResearchCommand = trimmedStart === '/skill-research' || trimmedStart.startsWith('/skill-research ')
    const isEditCommand = trimmedStart === '/edit' || trimmedStart.startsWith('/edit ')
    const isCommand = isDeepResearchCommand || isSkillResearchCommand
    const commandlessPrompt = isCommand ? trimmedStart.replace(/^\/(deep-research|skill-research)\s*/i, '') : trimmed
    const authorKey = self?.id ? String(self.id) : 'self'
    const authorName =
      typeof self?.presence?.name === 'string' && self.presence.name.trim()
        ? self.presence.name.trim()
        : 'User'
    const isEditPrompt = trimmedStart.startsWith('[edit]')

    appendChatMessage({
      id: `msg_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`,
      agentId,
      role: 'user',
      authorKey,
      authorName,
      content: trimmed,
      createdAt: new Date().toISOString(),
      deepResearch: isDeepResearchCommand ? true : undefined,
    })

    if (isEditCommand) {
      const seed = trimmedStart.replace(/^\/edit\s*/i, '')
      const change = activePendingForActiveAgent ?? null
      if (change) {
        triggerEditFlowForChange(change, seed)
      } else {
        appendChatMessage({
          id: `msg_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`,
          agentId,
          role: 'agent',
          authorKey: agentId,
          authorName: displayChatAgentName(agentId),
          content: 'No pending suggestion to edit for this agent.',
          createdAt: new Date().toISOString(),
        })
        focusChatInput()
      }
      setSlashMenuDismissed(true)
      setSlashMenuIndex(0)
      return
    }

    // If this is an edit prompt for the active pending change, call completeAction(edit).
    if (editingChangeId && isEditPrompt) {
      ;(async () => {
        try {
          const res = await completeAction({
            roomId,
            changeId: editingChangeId,
            action: 'edit',
            editPrompt: trimmed,
          })
          deletePendingChange(editingChangeId)
          clearAwaitingBackendChangeIfMatches(editingChangeId)
          setEditingChangeId(null)
          // Backend is expected to write the new PendingChange into Liveblocks storage.
        } catch (e: any) {
          console.warn('Edit failed:', e)
        }
      })()
      setChatInputValue('')
      return
    }

    setIsThinkingUi(true)
    ;(async () => {
      try {
        const backendAgentId = toBackendAgentId(agentId)
        const res = await apiRunAgent(backendAgentId, {
          room_id: roomId,
          prompt: commandlessPrompt,
          mode: isDeepResearchCommand || isSkillResearchCommand ? 'query' : 'generate',
        })

        const agentName = displayChatAgentName(agentId)

        if (res.answer && res.answer.trim()) {
          appendChatMessage({
            id: `msg_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`,
            agentId,
            role: 'agent',
            authorKey: agentId,
            authorName: agentName,
            content: res.answer.trim(),
            createdAt: new Date().toISOString(),
            deepResearch: isDeepResearchCommand ? true : undefined,
          })
        }

        if (res.change_id) {
          setAwaitingBackendChange({
            id: res.change_id,
            operationsCount: res.operations_count ?? 0,
            reasoning: res.reasoning ?? '',
            requestedAt: Date.now(),
          })
          appendChatMessage({
            id: `msg_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`,
            agentId,
            role: 'agent',
            authorKey: agentId,
            authorName: agentName,
            content: `Proposed canvas change: ${res.change_id}`,
            createdAt: new Date().toISOString(),
          })
        } else if (res.reasoning && res.reasoning.trim() && (!res.answer || !res.answer.trim())) {
          appendChatMessage({
            id: `msg_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`,
            agentId,
            role: 'agent',
            authorKey: agentId,
            authorName: agentName,
            content: res.reasoning.trim(),
            createdAt: new Date().toISOString(),
            deepResearch: isDeepResearchCommand ? true : undefined,
          })
        }
      } catch (e: any) {
        // Avoid writing synthetic system messages. Errors can still be shown in console.
        if (agentId !== systemAgentId) {
          appendChatMessage({
            id: `msg_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`,
            agentId,
            role: 'agent',
            authorKey: agentId,
            authorName: displayChatAgentName(agentId),
            content: `Agent run failed: ${String(e?.message ?? e)}`,
            createdAt: new Date().toISOString(),
          })
        } else {
          console.warn('System agent run failed:', e)
        }
      } finally {
        setIsThinkingUi(false)
      }
    })()

    setChatInputValue('')
    setSlashMenuDismissed(false)
    setSlashMenuIndex(0)
  }

  const spawnAgent = () => {
    if (!isStorageLoaded) return
    const defaultName = `Agent ${agents.filter((a) => a.id !== systemAgentId).length + 1}`
    setIsThinkingUi(true)
    ;(async () => {
      try {
        const res = await apiCreateAgent(roomId, { name: defaultName, type: 'chatbot' })
        const id = res.agent.id
        const name = res.agent.name || defaultName
        upsertAgentWithChat({
          agent: { id, name },
          initialMessage: {
            id: `msg_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`,
            role: 'agent',
            authorKey: id,
            authorName: name,
            content: `Hi, I am ${name}. What should I do?`,
            createdAt: new Date().toISOString(),
          },
        })
        setActiveAgentId(id)
        setChatInputValue('')
        focusChatInput()
      } catch (e: any) {
        console.warn('Create agent failed:', e)
      } finally {
        setIsThinkingUi(false)
      }
    })()
  }

  const removeAgent = (agentId: string) => {
    if (agentId === systemAgentId) return
    if (!isStorageLoaded) return
    removeAgentFromStorage(agentId)
    setActiveAgentId(systemAgentId)
  }

  const pendingChangeSummaries = useMemo(() => {
    if (!activePendingChange) return []
    if (activePendingChange.operations.length === 0) {
      const base = activePendingChange.reasoning ? [activePendingChange.reasoning] : ['Pending change']
      if (awaitingBackendChange?.id === activePendingChange.id) {
        base.push('Waiting for backend operations to sync into Liveblocks storage…')
      }
      return base
    }
    return activePendingChange.operations
      .map((op) => {
        if (op.op === 'add_shape' && op.shape?.type === 'note') {
          const text = (op.shape.props as any)?.richText
          const maybe =
            typeof text === 'object' ? JSON.stringify(text).slice(0, 120) : String(text ?? '')
          return `Add note: ${maybe || op.shape.id}`
        }
        if (op.op === 'add_shape' && op.shape) return `Add: ${op.shape.type} (${op.shape.id})`
        if (op.op === 'update_shape') return `Update: ${op.shapeId}`
        if (op.op === 'delete_shape') return `Delete: ${op.shapeId}`
        return 'Change'
      })
      .filter(Boolean)
  }, [activePendingChange])

  const participants = useMemo(() => {
    const list: Array<{ name?: string; color?: string; isSelf: boolean; key: string }> = []
    list.push({
      name: self?.presence?.name,
      color: self?.presence?.color,
      isSelf: true,
      key: self?.id ? String(self.id) : 'self',
    })
    others.forEach((o) => {
      list.push({
        name: o.presence?.name,
        color: o.presence?.color,
        isSelf: false,
        key: String(o.id),
      })
    })
    return list
  }, [others, self])

  const slashCommands = useMemo(
    () =>
      [
        { id: '/deep-research', label: 'Run exhaustive analysis' },
        { id: '/skill-research', label: 'Analyze required competencies' },
        { id: '/edit', label: 'Edit pending suggestion' },
      ] as const,
    [],
  )

  const slashMenuItems = useMemo(() => {
    const trimmed = chatInputValue.trimStart()
    if (!trimmed.startsWith('/')) return []
    if (trimmed.includes(' ')) return []
    const query = trimmed.toLowerCase()
    const items = slashCommands.filter((c) => c.id.startsWith(query === '/' ? '/' : query))
    return items
  }, [chatInputValue, slashCommands])

  const isSystemChat = activeAgentId === systemAgentId

  const slashMenuOpen =
    isStorageLoaded &&
    !slashMenuDismissed &&
    chatInputValue.trimStart().startsWith('/') &&
    slashMenuItems.length > 0

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        display: 'flex',
        background: '#f8fafc',
        overflow: 'hidden',
      }}
    >
      {/* Left sidebar */}
      {leftCollapsed ? (
        <div
          style={{
            width: 40,
            background: '#ffffff',
            borderRight: '0.5px solid rgba(15, 23, 42, 0.10)',
            display: 'flex',
            flexDirection: 'column',
            flexShrink: 0,
            alignItems: 'center',
          }}
        >
          <button
            type="button"
            aria-label="Open sidebar"
            onClick={() => setLeftCollapsed(false)}
            style={{
              marginTop: 10,
              width: 28,
              height: 28,
              borderRadius: 10,
              border: '0.5px solid rgba(15, 23, 42, 0.10)',
              background: '#ffffff',
              color: '#334155',
              fontWeight: 900,
              cursor: 'pointer',
            }}
          >
            &gt;
          </button>

            <div style={{ marginTop: 'auto', paddingBottom: 10, display: 'grid', gap: 8 }}>
              <button
                type="button"
                aria-label="Share"
                onClick={copyInviteLink}
                style={{
                  width: 28,
                  height: 28,
                borderRadius: 10,
                border: '0.5px solid rgba(15, 23, 42, 0.10)',
                background: '#ffffff',
                color: '#334155',
                fontWeight: 900,
                cursor: 'pointer',
                }}
                title="Share"
              >
                <ShareIcon />
              </button>
              <button
                type="button"
                aria-label="Exit"
                onClick={() => navigate('/')}
                style={{
                  width: 28,
                  height: 28,
                borderRadius: 10,
                border: '0.5px solid #fecaca',
                background: 'transparent',
                color: '#ef4444',
                fontWeight: 900,
                cursor: 'pointer',
                }}
                title="Exit"
              >
                <ExitIcon />
              </button>
            </div>
        </div>
      ) : (
        <div
          style={{
            width: 240,
            background: '#ffffff',
            borderRight: '0.5px solid rgba(15, 23, 42, 0.10)',
            display: 'flex',
            flexDirection: 'column',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              height: 48,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0 12px 0 16px',
              borderBottom: '0.5px solid rgba(15, 23, 42, 0.10)',
              color: '#0f172a',
              fontWeight: 600,
              fontSize: 15,
            }}
          >
            <div>Brainstorm</div>
            <button
              type="button"
              aria-label="Close sidebar"
              onClick={() => setLeftCollapsed(true)}
              style={{
                width: 28,
                height: 28,
                borderRadius: 10,
                border: '0.5px solid rgba(15, 23, 42, 0.10)',
                background: '#ffffff',
                color: '#64748b',
                fontWeight: 900,
                cursor: 'pointer',
              }}
            >
              ×
            </button>
          </div>

          <div style={{ padding: 16 }}>
            <div
              style={{
                color: '#0f172a',
                fontSize: 15,
                fontWeight: 500,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={roomName}
            >
              {roomName}
            </div>

            <div style={{ marginTop: 12 }}>
              <div
                onMouseEnter={() => setIsUsersHover(true)}
                onMouseLeave={() => setIsUsersHover(false)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  marginTop: 10,
                  position: 'relative',
                }}
              >
                {isUsersHover && !hoveredUserKey ? (
                  <div
                    style={{
                      position: 'absolute',
                      left: 0,
                      top: -34,
                      background: '#0f172a',
                      color: '#ffffff',
                      padding: '6px 8px',
                      borderRadius: 8,
                      fontSize: 12,
                      maxWidth: 200,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    pointerEvents: 'none',
                    boxShadow: '0 1px 2px rgba(15, 23, 42, 0.06)',
                  }}
                >
                    {participants
                      .map((p) =>
                        p.name
                          ? p.isSelf
                            ? `You — ${p.name}`
                            : p.name
                          : p.isSelf
                            ? 'You'
                            : 'User',
                      )
                      .join(', ')}
                  </div>
                ) : null}
                {participants.slice(0, 8).map((p, idx) => (
                  <div
                    key={p.key}
                    onMouseEnter={() => setHoveredUserKey(p.key)}
                    onMouseLeave={() => setHoveredUserKey((k) => (k === p.key ? null : k))}
                    title={p.isSelf ? `You${p.name ? ` — ${p.name}` : ''}` : p.name || 'User'}
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: '50%',
                      background: avatarBgColor(p.color),
                      color: 'white',
                      display: 'grid',
                      placeItems: 'center',
                      fontWeight: 900,
                      fontSize: 11,
                      marginLeft: idx === 0 ? 0 : -6,
                      border: '2px solid #ffffff',
                      position: 'relative',
                    }}
                  >
                    {avatarLabel(p.name)}
            <div
              style={{
                position: 'absolute',
                right: -1,
                bottom: -1,
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: '#22c55e',
                border: '2px solid #ffffff',
              }}
            />
                    {hoveredUserKey === p.key ? (
                      <div
                        style={{
                          position: 'absolute',
                          left: '50%',
                          top: -34,
                          transform: 'translateX(-50%)',
                          background: '#0f172a',
                          color: '#ffffff',
                          padding: '6px 8px',
                          borderRadius: 8,
                          fontSize: 12,
                        whiteSpace: 'nowrap',
                        pointerEvents: 'none',
                        boxShadow: '0 1px 2px rgba(15, 23, 42, 0.06)',
                        zIndex: 5,
                      }}
                    >
                        {p.isSelf ? `You${p.name ? ` — ${p.name}` : ''}` : p.name || 'User'}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div style={{ marginTop: 'auto', padding: 16 }}>
            <div style={{ display: 'grid', gap: 10 }}>
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  type="button"
                  onClick={copyInviteLink}
                  style={{
                    flex: 1,
                    background: '#f8fafc',
                    border: '0.5px solid #e2e8f0',
                    color: '#334155',
                    borderRadius: 8,
                    padding: '8px 14px',
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                  }}
                >
                  <ShareIcon />
                  Share
                </button>
                <button
                  type="button"
                  onClick={() => navigate('/')}
                  style={{
                    background: 'transparent',
                    border: '0.5px solid #fecaca',
                    color: '#ef4444',
                    borderRadius: 8,
                    padding: '8px 14px',
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                  }}
                >
                  <ExitIcon />
                  Exit
                </button>
              </div>
              {copyStatus !== 'idle' ? (
                <div style={{ color: '#94a3b8', fontSize: 11 }}>
                  {copyStatus === 'copied'
                    ? 'Copied ✓'
                    : copyStatus === 'failed'
                      ? 'Copy failed (browser blocked clipboard)'
                      : ''}
                </div>
              ) : null}
              <div style={{ fontSize: 11, color: '#94a3b8', fontStyle: 'italic', marginTop: 2 }}>
                ✦ autocomplete active
              </div>
            </div>
          </div>
        </div>
      )}

	      {/* Center canvas */}
	      <div
	        ref={canvasHostRef}
	        style={{
	          flex: 1,
	          position: 'relative',
	          overflow: 'hidden',
          // Prevent the browser from handling touch gestures (scroll/zoom) so tldraw doesn't need
          // to call preventDefault in passive touch listeners (Chrome logs warnings otherwise).
          touchAction: 'none',
          overscrollBehavior: 'none',
        }}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
	        onPointerDownCapture={() => {
	          editorRef.current?.focus()
	        }}
		      >
		        <button
		          type="button"
		          aria-label={rightSidebarOpen ? 'Hide agents panel' : 'Show agents panel'}
		          onClick={() => setRightSidebarOpen((v) => !v)}
		          style={{
		            position: 'fixed',
		            top: 12,
		            right: rightSidebarOpen ? rightSidebarWidth + 12 : 12,
		            zIndex: 1000,
		            width: 38,
		            height: 38,
		            borderRadius: 12,
		            background: '#ffffff',
		            border: '0.5px solid rgba(15, 23, 42, 0.12)',
		            boxShadow: '0 1px 2px rgba(15, 23, 42, 0.06)',
		            color: rightSidebarOpen ? '#0f172a' : '#1d4ed8',
		            cursor: 'pointer',
		            display: 'flex',
		            alignItems: 'center',
		            justifyContent: 'center',
		            pointerEvents: 'auto',
		          }}
		          title="Agents"
		        >
	          <AgentsPanelIcon open={rightSidebarOpen} />
	        </button>

	        <Tldraw onMount={onMount} user={tldrawUser} overrides={tldrawUiOverrides as any} />

        {/* Pending suggestion pill */}
        {pendingChanges.length > 0 ? (
          <div
            style={{
              position: 'absolute',
              bottom: 80,
              left: '50%',
              transform: 'translateX(-50%)',
              background: '#ffffff',
              border: '0.5px solid #e2e8f0',
              borderRadius: 20,
              padding: '8px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              boxShadow: '0 2px 12px rgba(0,0,0,0.08)',
              zIndex: 20,
              pointerEvents: 'auto',
            }}
          >
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: requestedByColorForPill,
              }}
            />
            <div style={{ color: '#334155', fontSize: 13, fontWeight: 700 }}>AI suggestion ready</div>
            <button
              type="button"
              onClick={acceptPendingChange}
              style={{
                background: '#0f172a',
                color: 'white',
                border: 'none',
                borderRadius: 8,
                padding: '4px 12px',
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              Accept
            </button>
            <button
              type="button"
              onClick={rejectPendingChange}
              style={{
                background: 'transparent',
                color: '#94a3b8',
                border: 'none',
                borderRadius: 8,
                padding: '4px 8px',
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              Dismiss
            </button>
          </div>
        ) : null}

        {/* Live cursors */}
        {others.map((o) => {
          const cursor = o.presence?.cursor
          if (!cursor) return null
          const name = o.presence?.name
          const color = avatarBgColor(o.presence?.color)
          return (
            <div
              key={String(o.id)}
              style={{
                position: 'fixed',
                left: cursor.x,
                top: cursor.y,
                transform: 'translate(8px, 8px)',
                zIndex: 30,
                pointerEvents: 'none',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  background: color,
                  boxShadow: '0 6px 18px rgba(15, 23, 42, 0.16)',
                  border: '2px solid #ffffff',
                }}
              />
              <div
                style={{
                  background: '#0f172a',
                  color: '#ffffff',
                  fontSize: 12,
                  fontWeight: 700,
                  padding: '6px 8px',
                  borderRadius: 10,
                  maxWidth: 220,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  boxShadow: '0 10px 22px rgba(15, 23, 42, 0.12)',
                }}
              >
                {name && name.trim() ? name : 'User'}
              </div>
            </div>
          )
        })}

        {/* Pending AI changes (System) */}
        {activePendingChange ? (
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              zIndex: 1000,
              width: 420,
              maxWidth: 'min(520px, calc(100vw - 48px))',
              pointerEvents: 'auto',
            }}
          >
            <div
              className="border-2 border-dashed border-purple-300 bg-purple-50/20 rounded-xl"
              style={{
                padding: 14,
                boxShadow: '0 1px 2px rgba(15, 23, 42, 0.06)',
                backgroundColor: 'rgba(250, 245, 255, 0.20)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ color: '#0f172a', fontWeight: 700, fontSize: 13 }}>
                  Pending AI changes (System)
                </div>
                <div style={{ color: '#94a3b8', fontSize: 12 }}>
                  {displayedPendingOperationsCount} item(s)
                </div>
              </div>

              <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
                {pendingChangeSummaries.slice(0, 4).map((txt, idx) => (
                  <div
                    key={`${idx}-${txt}`}
                    style={{
                      background: '#ffffff',
                      border: '0.5px solid rgba(15, 23, 42, 0.10)',
                      borderRadius: 10,
                      padding: '8px 10px',
                      color: '#334155',
                      fontSize: 12,
                      opacity: 0.9,
                    }}
                    title={txt}
                  >
                    {txt}
                  </div>
                ))}
                {pendingChangeSummaries.length > 4 ? (
                  <div style={{ color: '#94a3b8', fontSize: 12 }}>
                    +{pendingChangeSummaries.length - 4} more…
                  </div>
                ) : null}
              </div>
            </div>

            <div
              className="bg-white shadow-lg border border-slate-100 rounded-full px-2 py-1 flex gap-2 backdrop-blur-md"
              style={{
                marginTop: 10,
                display: 'flex',
                width: 'fit-content',
                marginLeft: 'auto',
                marginRight: 'auto',
              }}
            >
              <button
                onClick={acceptPendingChange}
                style={{
                  border: 'none',
                  background: 'transparent',
                  borderRadius: 999,
                  padding: '6px 10px',
                  fontSize: 12,
                  fontWeight: 700,
                  color: '#16a34a',
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => {
                  ;(e.currentTarget as HTMLButtonElement).style.background = 'rgba(34, 197, 94, 0.10)'
                }}
                onMouseLeave={(e) => {
                  ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
                }}
              >
                ✓ Yes
              </button>
              <button
                onClick={rejectPendingChange}
                style={{
                  border: 'none',
                  background: 'transparent',
                  borderRadius: 999,
                  padding: '6px 10px',
                  fontSize: 12,
                  fontWeight: 700,
                  color: '#ef4444',
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => {
                  ;(e.currentTarget as HTMLButtonElement).style.background = 'rgba(239, 68, 68, 0.10)'
                }}
                onMouseLeave={(e) => {
                  ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
                }}
              >
                ✕ No
	              </button>
	              <button
	                onClick={() => triggerEditFlow()}
	                style={{
	                  border: 'none',
	                  background: 'transparent',
                  borderRadius: 999,
                  padding: '6px 10px',
                  fontSize: 12,
                  fontWeight: 700,
                  color: '#334155',
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => {
                  ;(e.currentTarget as HTMLButtonElement).style.background = 'rgba(15, 23, 42, 0.06)'
                }}
                onMouseLeave={(e) => {
                  ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
                }}
              >
                ✏️ Edit
              </button>
            </div>
          </div>
        ) : null}

        {/* Decision checkpoint modal */}
        {checkpointOpen ? (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(15,23,42,0.04)',
              zIndex: 15,
              pointerEvents: 'none',
              display: 'grid',
              placeItems: 'center',
              padding: 16,
            }}
          >
            <div
              style={{
                pointerEvents: 'auto',
                background: 'white',
                borderRadius: 16,
                padding: 24,
                maxWidth: 400,
                width: '100%',
                boxShadow: '0 1px 2px rgba(15, 23, 42, 0.06)',
                border: '0.5px solid rgba(15, 23, 42, 0.10)',
              }}
            >
              <div style={{ color: '#0f172a', fontSize: 15, fontWeight: 700 }}>
                🔵 Decision checkpoint
              </div>
              <div style={{ color: '#94a3b8', fontSize: 13, marginTop: 6 }}>
                What decision does the team need to make?
              </div>
              <textarea
                rows={3}
                value={checkpointValue}
                onChange={(e) => setCheckpointValue(e.target.value)}
                style={{
                  width: '100%',
                  marginTop: 12,
                  border: '0.5px solid #e2e8f0',
                  borderRadius: 8,
                  padding: '10px 12px',
                  fontSize: 13,
                  color: '#0f172a',
                  outline: 'none',
                  resize: 'none',
                }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 14 }}>
                <button
                  onClick={() => setCheckpointOpen(false)}
                  style={{
                    background: '#f8fafc',
                    border: '0.5px solid #e2e8f0',
                    color: '#334155',
                    borderRadius: 10,
                    padding: '10px 12px',
                    fontSize: 13,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={async () => {
                    const hint = checkpointValue.trim()
                    setCheckpointOpen(false)
                    setCheckpointValue('')
                    if (!hint) return
                    await runAutocompleteWithHint(hint)
                  }}
                  style={{
                    background: '#1E293B',
                    border: 'none',
                    color: 'white',
                    borderRadius: 10,
                    padding: '10px 12px',
                    fontSize: 13,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  Run checkpoint
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {/* Multi-Agent Control Center */}
      {rightSidebarOpen ? (
        <div
          style={{
            width: rightSidebarWidth,
            background: '#ffffff',
            borderLeft: '0.5px solid rgba(15, 23, 42, 0.10)',
            display: 'flex',
            flexDirection: 'column',
            flexShrink: 0,
            position: 'relative',
          }}
        >
        {/* Resize handle */}
        <div
          onMouseDown={() => {
            isResizingRightSidebarRef.current = true
            document.body.style.cursor = 'col-resize'
            document.body.style.userSelect = 'none'
          }}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: 4,
            cursor: 'col-resize',
            zIndex: 5,
          }}
          aria-hidden="true"
        />
        {/* Top: Agent Dock */}
        <div style={{ padding: 12, borderBottom: '0.5px solid rgba(15, 23, 42, 0.10)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: '#94a3b8' }}>Agents</div>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              aria-label="Close agents panel"
              onClick={() => setRightSidebarOpen(false)}
              style={{
                border: '0.5px solid rgba(15, 23, 42, 0.10)',
                background: '#ffffff',
                color: '#94a3b8',
                borderRadius: 10,
                width: 28,
                height: 28,
                cursor: 'pointer',
                fontSize: 16,
                lineHeight: '16px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              ×
            </button>
          </div>

          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                flex: 1,
                display: 'flex',
                gap: 8,
                overflowX: 'auto',
                paddingBottom: 4,
              }}
            >
	              {(() => {
	                const systemActive = activeAgentId === systemAgentId
	                const baseTabStyle: Record<string, any> = {
	                  border: '0.5px solid rgba(15, 23, 42, 0.10)',
	                  padding: '8px 10px',
	                  fontSize: 12,
	                  fontWeight: 800,
	                  cursor: 'pointer',
	                  whiteSpace: 'nowrap',
	                }
	                return (
	                  <>
		                    <button
		                      onClick={() => setActiveAgentId(systemAgentId)}
	                      style={{
	                        ...baseTabStyle,
	                        background: systemActive ? '#0f172a' : '#f8fafc',
	                        color: systemActive ? '#ffffff' : '#64748b',
	                        borderBottom: systemActive ? 'none' : '0.5px solid rgba(15, 23, 42, 0.10)',
	                        borderRadius: systemActive ? '10px 10px 0 0' : 10,
	                      }}
		                    >
		                      System
		                    </button>

	                    {agents
	                      .filter((a) => a.id !== systemAgentId)
	                      .map((a) => {
                        const active = a.id === activeAgentId
                        return (
                          <div
                            key={a.id}
                            onClick={() => setActiveAgentId(a.id)}
                            style={{
                              ...baseTabStyle,
                              background: active ? '#0f172a' : '#f8fafc',
                              color: active ? '#ffffff' : '#64748b',
                              borderBottom: active ? 'none' : '0.5px solid rgba(15, 23, 42, 0.10)',
                              borderRadius: active ? '10px 10px 0 0' : 10,
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              userSelect: 'none',
                            }}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                setActiveAgentId(a.id)
                              }
                            }}
                          >
                            <span style={{ fontWeight: 800 }}>{a.name}</span>
                            <button
                              type="button"
                              aria-label={`Remove ${a.name}`}
                              onClick={(e) => {
                                e.preventDefault()
                                e.stopPropagation()
                                removeAgent(a.id)
                              }}
                              style={{
                                border: 'none',
                                background: 'transparent',
                                color: active ? 'rgba(255,255,255,0.85)' : '#94a3b8',
                                cursor: 'pointer',
                                fontSize: 12,
                                lineHeight: '12px',
                                padding: 0,
                              }}
                            >
                              ×
                            </button>
                          </div>
                        )
                      })}
                  </>
                )
              })()}
            </div>

	            <button
	              disabled={!isStorageLoaded}
	              onClick={spawnAgent}
	              style={{
	                border: '0.5px solid rgba(59, 130, 246, 0.40)',
	                background: isStorageLoaded ? '#ffffff' : '#f8fafc',
	                color: isStorageLoaded ? '#1d4ed8' : '#94a3b8',
	                borderRadius: 999,
	                padding: '4px 10px',
	                fontSize: 12,
	                fontWeight: 800,
	                cursor: isStorageLoaded ? 'pointer' : 'not-allowed',
	                whiteSpace: 'nowrap',
	                opacity: isStorageLoaded ? 1 : 0.8,
	              }}
	            >
	              + New
	            </button>
          </div>
        </div>

        {/* Middle: Agent-Specific Chat */}
        <div
          style={{
            flex: 1,
            background: '#f8fafc',
            overflowY: 'auto',
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          {activePendingForActiveAgent ? (
            <div
              style={{
                background: '#ffffff',
                border: '0.5px solid rgba(15, 23, 42, 0.10)',
                borderRadius: 14,
                padding: 12,
                boxShadow: '0 1px 2px rgba(15, 23, 42, 0.06)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 900, color: '#0f172a' }}>
                    Pending canvas change
                  </div>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>
                    {pendingForActiveAgent.length} pending · {displayAgentName(activeAgentId)}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => acceptPendingChangeForAgent(activePendingForActiveAgent)}
                    style={{
                      border: '0.5px solid rgba(34, 197, 94, 0.35)',
                      background: '#ffffff',
                      color: '#16a34a',
                      borderRadius: 999,
                      padding: '6px 10px',
                      fontSize: 12,
                      fontWeight: 900,
                      cursor: 'pointer',
                    }}
                  >
                    ✓ Yes
                  </button>
                  <button
                    type="button"
                    onClick={() => rejectPendingChangeForAgent(activePendingForActiveAgent)}
                    style={{
                      border: '0.5px solid rgba(239, 68, 68, 0.28)',
                      background: 'transparent',
                      color: '#ef4444',
                      borderRadius: 999,
                      padding: '6px 10px',
                      fontSize: 12,
                      fontWeight: 900,
                      cursor: 'pointer',
                    }}
                  >
                    ✕ No
                  </button>
                  <button
                    type="button"
                    onClick={() => triggerEditFlowForChange(activePendingForActiveAgent)}
                    style={{
                      border: '0.5px solid rgba(15, 23, 42, 0.10)',
                      background: '#f8fafc',
                      color: '#334155',
                      borderRadius: 999,
                      padding: '6px 10px',
                      fontSize: 12,
                      fontWeight: 900,
                      cursor: 'pointer',
                    }}
                  >
                    ✏️ Edit
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {chatMessages.length === 0 ? (
            <div
              style={{
                marginTop: 12,
                color: '#94a3b8',
                fontSize: 13,
                textAlign: 'center',
              }}
            >
              No messages yet.
            </div>
          ) : (
            chatMessages.map((m) => {
              const selfKey = self?.id ? String(self.id) : 'self'
              const isSelfMessage = m.role === 'user' && m.authorKey === selfKey
              const isAgent = m.role === 'agent'
              const isEdit = isSystemChat && m.role === 'user' && m.content.trimStart().startsWith('[edit]')
              return (
                <div
                  key={m.id}
                  style={{
                    display: 'flex',
                    justifyContent: isSelfMessage ? 'flex-end' : 'flex-start',
                  }}
                >
	                  <div
	                    style={{
	                      maxWidth: '88%',
	                      background: isAgent ? '#F5F3FF' : '#f8fafc',
	                      border: isEdit
	                        ? '0.5px solid rgba(99, 102, 241, 0.35)'
	                        : isAgent
	                          ? '0.5px solid rgba(76, 29, 149, 0.10)'
	                          : '0.5px solid #e2e8f0',
	                      borderRadius: 12,
	                      padding: '10px 10px',
	                      color: isAgent ? '#4c1d95' : '#334155',
	                      boxShadow: '0 1px 2px rgba(15, 23, 42, 0.06)',
	                      whiteSpace: 'pre-wrap',
	                      overflowWrap: 'anywhere',
	                      textAlign: m.role === 'user' ? 'right' : 'left',
	                    }}
	                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 10,
                        marginBottom: 6,
                      }}
                    >
	                      <div style={{ fontSize: 11, fontWeight: 800, color: isAgent ? '#4c1d95' : '#334155' }}>
	                        {m.authorName}
	                      </div>
                      {isEdit ? (
                        <div
                          style={{
                            fontSize: 10,
                            fontWeight: 900,
                            color: '#4338ca',
                            background: 'rgba(224, 231, 255, 0.70)',
                            border: '0.5px solid rgba(99, 102, 241, 0.25)',
                            padding: '2px 6px',
                            borderRadius: 999,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          EDIT
                        </div>
                      ) : m.deepResearch ? (
                        <div
                          style={{
                            fontSize: 10,
                            fontWeight: 800,
                            color: '#4338ca',
                            background: 'rgba(224, 231, 255, 0.70)',
                            border: '0.5px solid rgba(99, 102, 241, 0.25)',
                            padding: '2px 6px',
                            borderRadius: 999,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          Deep Research
                        </div>
                      ) : null}
                    </div>
	                    <div style={{ fontSize: 13, lineHeight: isAgent ? '1.6' : '18px' }}>{m.content}</div>
	                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* Bottom: Command Input */}
        <div
          style={{
            padding: 12,
            borderTop: '0.5px solid rgba(15, 23, 42, 0.10)',
            background: '#ffffff',
            position: 'relative',
          }}
        >
          {slashMenuOpen ? (
            <div
              style={{
                position: 'absolute',
                left: 12,
                right: 12,
                bottom: 64,
                background: '#ffffff',
                border: '0.5px solid rgba(15, 23, 42, 0.10)',
                borderRadius: 12,
                boxShadow: '0 1px 2px rgba(15, 23, 42, 0.06)',
                overflow: 'hidden',
              }}
              role="listbox"
              aria-label="Slash commands"
            >
              {slashMenuItems.map((item, idx) => {
                const active = idx === slashMenuIndex
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => applySlashCommand(item.id)}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      padding: '10px 12px',
                      background: active ? '#f8fafc' : '#ffffff',
                      border: 'none',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'baseline',
                      justifyContent: 'space-between',
                      gap: 12,
                      color: '#0f172a',
                      fontSize: 13,
                    }}
                  >
                    <span style={{ fontWeight: 800 }}>{item.id}</span>
                    <span style={{ color: '#94a3b8', fontWeight: 600, fontSize: 12 }}>{item.label}</span>
                  </button>
                )
              })}
            </div>
          ) : null}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              ref={chatInputRef}
              value={chatInputValue}
              onChange={(e) => setChatInputValue(e.target.value)}
              disabled={!isStorageLoaded}
              onKeyDown={(e) => {
                if (slashMenuOpen) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setSlashMenuIndex((i) => Math.min(i + 1, slashMenuItems.length - 1))
                    return
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setSlashMenuIndex((i) => Math.max(i - 1, 0))
                    return
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setSlashMenuDismissed(true)
                    return
                  }
                  if (e.key === 'Enter') {
                    const selected = slashMenuItems[slashMenuIndex]
                    if (selected) {
                      e.preventDefault()
                      applySlashCommand(selected.id)
                      return
                    }
                  }
                }

                if (e.key !== 'Enter') return
                e.preventDefault()
                sendChatMessage(chatInputValue)
              }}
	              placeholder="Ask or instruct..."
              style={{
                flex: 1,
                background: '#f8fafc',
                border: '0.5px solid rgba(15, 23, 42, 0.10)',
                color: isStorageLoaded ? '#0f172a' : '#94a3b8',
                borderRadius: 12,
                padding: '10px 12px',
                fontSize: 13,
                outline: 'none',
              }}
            />
            <button
              type="button"
              aria-label="Send"
              disabled={!isStorageLoaded}
              onClick={() => sendChatMessage(chatInputValue)}
              style={{
                border: '0.5px solid rgba(15, 23, 42, 0.10)',
                background: isStorageLoaded ? '#ffffff' : '#f8fafc',
                color: isStorageLoaded ? '#0f172a' : '#94a3b8',
                borderRadius: 12,
                padding: '10px 12px',
                fontSize: 13,
                fontWeight: 900,
                cursor: isStorageLoaded ? 'pointer' : 'not-allowed',
                opacity: isStorageLoaded ? 1 : 0.8,
              }}
            >
              &gt;
            </button>
          </div>

          {/* Bottom actions moved to left sidebar */}
        </div>
      </div>
      ) : null}
	    </div>
	  )
	}

function HomeScreen({
  rooms,
  onCreate,
  onJoin,
  onOpen,
  user,
}: {
  rooms: RoomEntry[]
  onCreate: (name: string) => void
  onJoin: (roomId: string, name?: string) => void
  onOpen: (entry: RoomEntry) => void
  user: ApiUser
}) {
  const [joinInput, setJoinInput] = useState('')
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [newRoomName, setNewRoomName] = useState('')
  const [searchQuery, setSearchQuery] = useState('')

  const filteredRooms = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return rooms
    return rooms.filter((r) => `${r.name} ${r.id}`.toLowerCase().includes(q))
  }, [rooms, searchQuery])

  return (
    <div className="h-screen w-screen bg-[#f8fafc] flex flex-col font-sans text-[#0f172a] overflow-hidden">
      {/* Top Header */}
      <header className="h-16 bg-white border-b border-slate-200/60 flex items-center justify-between px-6 shrink-0">
        <div className="flex items-center gap-2">
          <div className="text-lg font-bold">⚡️ AI Brainstorm</div>
        </div>

        <div className="hidden md:flex items-center justify-center">
          <div className="relative w-96">
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search boards..."
              className="bg-slate-50 border border-slate-200 rounded-full px-4 py-2 w-full text-sm text-[#0f172a] placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200"
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div
            className="h-7 w-7 rounded-full flex items-center justify-center text-white font-semibold text-xs"
            style={{ background: avatarBgColor(user.color) }}
            aria-label="User avatar"
          >
            {avatarLabel(user.username)}
          </div>
          <div className="text-[13px] text-[#334155]">{user.username}</div>
        </div>
      </header>

      {/* Bottom Section */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Sidebar */}
        <aside className="w-64 bg-white border-r border-slate-200/60 flex flex-col p-4 shrink-0">
          <nav className="flex flex-col gap-1">
            <div className="text-xs uppercase tracking-wide text-slate-400 font-semibold mb-2">
              Navigation
            </div>
            {[
              { label: 'Dashboard', icon: '🏠', onClick: () => setTemplatesOpen(false) },
              { label: 'Templates', icon: '🧩', onClick: () => setTemplatesOpen((v) => !v) },
            ].map((item) => (
              <button
                key={item.label}
                type="button"
                className="flex items-center gap-2 hover:bg-slate-50 rounded-lg p-2 text-sm text-[#475569] transition-colors"
                onClick={() => {
                  item.onClick?.()
                }}
              >
                <span className="text-[#94a3b8]">{item.icon}</span>
                <span className="flex items-center gap-2">
                  {item.label}
                  {item.label === 'Templates' ? (
                    <span className="bg-[#f1f5f9] text-[#94a3b8] text-[10px] rounded px-[6px] py-[1px]">
                      Soon
                    </span>
                  ) : null}
                </span>
              </button>
            ))}
            {templatesOpen ? (
              <div className="ml-9 mt-1 text-xs text-[#94a3b8]">Coming soon</div>
            ) : null}
          </nav>

          <div className="mt-6">
            <div className="text-xs uppercase tracking-wide text-slate-400 font-semibold mb-2">
              Join a board
            </div>
            <div className="flex flex-col gap-2">
              <input
                value={joinInput}
                onChange={(e) => setJoinInput(e.target.value)}
                placeholder="Paste room link or ID"
                className="bg-white border border-slate-200/60 rounded-xl px-3 py-2 text-sm text-[#0f172a] placeholder:text-[#94a3b8] focus:outline-none focus:ring-2 focus:ring-slate-200"
              />
              <button
                type="button"
                className="bg-white border border-slate-200/60 rounded-xl px-3 py-2 text-sm font-medium text-[#475569] hover:bg-slate-50 transition-colors"
                onClick={() => {
                  const parsed = parseJoinInput(joinInput)
                  if (!parsed.roomId) return
                  onJoin(parsed.roomId, parsed.name)
                }}
              >
                Join with link
              </button>
            </div>
          </div>

          <div className="mt-auto pt-4 text-xs text-[#94a3b8]">
            Powered by liveblocks
          </div>
        </aside>

        {/* Main Content Area */}
        <main className="flex-1 overflow-y-auto p-8">
          {/* Section A */}
          <section>
            <h2 className="text-xl font-bold mb-4">Start a new brainstorm</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4 mb-10">
              <div className="bg-white rounded-2xl p-6 border border-slate-200/60 shadow-sm hover:shadow-md hover:border-slate-300 transition-all cursor-pointer flex flex-col items-center justify-center text-center h-40">
                {!createOpen ? (
                  <button
                    type="button"
                    className="w-full h-full flex flex-col items-center justify-center text-center"
                    onClick={() => {
                      setCreateOpen(true)
                      setNewRoomName('')
                    }}
                  >
                    <div className="text-2xl text-[#94a3b8] mb-2">✨</div>
                    <div className="font-semibold">New brainstorm</div>
                    <div className="text-sm text-[#475569] mt-1">Start fresh</div>
                  </button>
                ) : (
                  <div className="w-full">
                    <input
                      value={newRoomName}
                      onChange={(e) => setNewRoomName(e.target.value)}
                      placeholder="Name your brainstorm..."
                      autoFocus
                      className="w-full border border-[#e2e8f0] rounded-lg px-3 py-2 text-[14px] text-[#0f172a] outline-none focus:ring-2 focus:ring-slate-200"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          const name = newRoomName.trim() ? newRoomName.trim() : 'Untitled room'
                          setCreateOpen(false)
                          onCreate(name)
                        }
                      }}
                    />
                    <div className="mt-3 flex items-center gap-2">
                      <button
                        type="button"
                        className="bg-[#0f172a] text-white rounded-lg px-4 py-2 text-[13px]"
                        onClick={() => {
                          const name = newRoomName.trim() ? newRoomName.trim() : 'Untitled room'
                          setCreateOpen(false)
                          onCreate(name)
                        }}
                      >
                        Create
                      </button>
                      <button
                        type="button"
                        className="bg-transparent text-[#94a3b8] text-[13px] px-2 py-2"
                        onClick={() => {
                          setCreateOpen(false)
                          setNewRoomName('')
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Section B */}
	          <section>
	            <h2 className="text-xl font-bold mb-4">Recent Collaborative Boards</h2>
	            {filteredRooms.length === 0 ? (
	              <div className="text-[#475569] text-sm">No recent sessions</div>
	            ) : (
	              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
	                {filteredRooms.map((room) => (
	                  <div
	                    key={room.id}
	                    className="bg-white rounded-2xl border border-slate-200/60 shadow-sm flex flex-col overflow-hidden"
	                  >
                    <div className="h-32 bg-slate-50 border-b border-slate-100" />
                    <div className="p-4 flex flex-col gap-2">
                      <div className="truncate font-medium text-[#0f172a]" title={room.id}>
                        {room.name}
                      </div>
                      <div className="text-xs text-[#94a3b8] truncate" title={room.id}>
                        {room.id}
                      </div>
                      <button
                        type="button"
                        className="bg-[#0f172a] text-white rounded-lg px-4 py-2 text-sm font-medium w-full text-center hover:bg-slate-800 transition-colors"
                        onClick={() => onOpen(room)}
                      >
                        Join Board
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  )
}

export default function App() {
  const { pathname, search, navigate } = useLocation()
  const roomIdFromPath = getRoomIdFromPath(pathname)
  const roomNameFromUrl = roomIdFromPath
    ? getRoomNameFromSearch(search) ?? roomIdFromPath
    : null

  const [user, setUser] = useState<ApiUser | null>(null)
  const [rooms, setRooms] = useState<RoomEntry[]>([])

  const refreshRooms = async () => {
    const list = await getRooms()
    setRooms(list)
  }

  useEffect(() => {
    ; (async () => {
      const u = await getUser()
      setUser(u)
    })()
  }, [])

  useEffect(() => {
    refreshRooms()
  }, [])

  useEffect(() => {
    if (!roomIdFromPath) return
      ; (async () => {
        await joinRoom(roomIdFromPath, roomNameFromUrl ?? undefined)
        refreshRooms()
      })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomIdFromPath, roomNameFromUrl])

  if (!user) {
    return <div style={{ padding: 24 }}>Loading…</div>
  }

  if (!roomIdFromPath) {
    return (
      <HomeScreen
        rooms={rooms}
        user={user}
        onOpen={(entry) => navigate(roomUrl(entry.id, entry.name))}
        onCreate={async (name) => {
          const { roomId, name: storedName } = await createRoom(name)
          await refreshRooms()
          navigate(roomUrl(roomId, storedName))
        }}
        onJoin={async (roomId, name) => {
          const { roomId: joinedId, name: joinedName } = await joinRoom(roomId, name)
          if (!joinedId) return
          await refreshRooms()
          navigate(roomUrl(joinedId, joinedName))
        }}
      />
    )
  }

  return (
    <RoomShell
      roomId={roomIdFromPath}
      roomName={roomNameFromUrl ?? roomIdFromPath}
      user={user}
      navigate={navigate}
    />
  )
}
