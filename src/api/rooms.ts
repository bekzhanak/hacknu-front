const ROOMS_KEY = 'brainstorm_rooms'

export type RoomEntry = { id: string; name: string }

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function normalizeRoomId(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  return trimmed.startsWith('room-') ? trimmed.slice('room-'.length) : trimmed
}

function dedupeRooms(rooms: RoomEntry[]): RoomEntry[] {
  const seen = new Set<string>()
  const out: RoomEntry[] = []
  for (const r of rooms) {
    const id = normalizeRoomId(r.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({ id, name: r.name?.trim() ? r.name.trim() : id })
  }
  return out
}

function readRooms(): RoomEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(ROOMS_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    if (!Array.isArray(parsed)) return []

    // Migration: previous format was string[] of room ids.
    const asStrings = parsed.filter((x): x is string => typeof x === 'string')
    if (asStrings.length === parsed.length) {
      return dedupeRooms(
        asStrings.map((id) => {
          const normalized = normalizeRoomId(id)
          return { id: normalized, name: normalized }
        }),
      )
    }

    const asEntries = parsed
      .filter((x): x is RoomEntry => !!x && typeof x === 'object')
      .map((x) => {
        const obj = x as any
        const id = typeof obj.id === 'string' ? normalizeRoomId(obj.id) : ''
        const name = typeof obj.name === 'string' ? obj.name : id
        return { id, name }
      })

    return dedupeRooms(asEntries)
  } catch {
    return []
  }
}

function writeRooms(rooms: RoomEntry[]) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(ROOMS_KEY, JSON.stringify(rooms))
  } catch {
    // ignore
  }
}

// Mocked API: GET /api/rooms
export async function getRooms(): Promise<RoomEntry[]> {
  return readRooms()
}

// Mocked API: POST /api/rooms
export async function createRoom(name: string): Promise<{ roomId: string; name: string }> {
  const roomId = randomId()
  const displayName = name.trim() ? name.trim() : roomId
  const rooms = readRooms()
  const next = [{ id: roomId, name: displayName }, ...rooms.filter((r) => r.id !== roomId)]
  writeRooms(dedupeRooms(next))
  return { roomId, name: displayName }
}

// Mocked API: POST /api/rooms/join
export async function joinRoom(
  roomId: string,
  name?: string,
): Promise<{ roomId: string; name: string }> {
  const normalizedId = normalizeRoomId(roomId)
  if (!normalizedId) return { roomId: '', name: '' }

  const rooms = readRooms()
  const existing = rooms.find((r) => r.id === normalizedId)
  const displayName = name?.trim()
    ? name.trim()
    : existing?.name?.trim()
      ? existing.name.trim()
      : normalizedId

  const next = [{ id: normalizedId, name: displayName }, ...rooms.filter((r) => r.id !== normalizedId)]
  writeRooms(dedupeRooms(next))
  return { roomId: normalizedId, name: displayName }
}
