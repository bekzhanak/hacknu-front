export type ApiUser = {
  userId: string
  username: string
  color: string
}

const USER_ID_KEY = 'brainstorm_user_id'
const USERNAME_KEY = 'brainstorm_username'
const COLOR_KEY = 'brainstorm_color'

const COLORS = ['#3B82F6', '#8B5CF6', '#EC4899', '#10B981', '#F59E0B'] as const

const ADJECTIVES = [
  'swift',
  'brave',
  'calm',
  'curious',
  'bright',
  'quiet',
  'wild',
  'witty',
  'gentle',
  'clever',
]

const ANIMALS = [
  'fox',
  'owl',
  'otter',
  'panda',
  'tiger',
  'eagle',
  'dolphin',
  'koala',
  'lynx',
  'wolf',
]

function randomFrom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

// Mocked API: GET /api/user
export async function getUser(): Promise<ApiUser> {
  if (typeof window === 'undefined') {
    return { userId: 'server', username: 'server-user', color: COLORS[0] }
  }

  const storage = window.localStorage
  let userId = storage.getItem(USER_ID_KEY) || ''
  let username = storage.getItem(USERNAME_KEY) || ''
  let color = storage.getItem(COLOR_KEY) || ''

  if (!userId) {
    userId = randomId()
    storage.setItem(USER_ID_KEY, userId)
  }

  if (!username) {
    username = `${randomFrom(ADJECTIVES)}-${randomFrom(ANIMALS)}`
    storage.setItem(USERNAME_KEY, username)
  }

  if (!color) {
    color = randomFrom(COLORS)
    storage.setItem(COLOR_KEY, color)
  }

  return { userId, username, color }
}

