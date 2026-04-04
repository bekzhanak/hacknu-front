const FRONTEND_HOST_KEY = 'brainstorm_frontend_host'

export async function getFrontendHost(): Promise<string | null> {
  if (typeof window === 'undefined') return null
  try {
    const value = window.localStorage.getItem(FRONTEND_HOST_KEY)
    return value && value.trim() ? value.trim() : null
  } catch {
    return null
  }
}

export async function setFrontendHost(host: string): Promise<void> {
  if (typeof window === 'undefined') return
  const trimmed = host.trim()
  try {
    if (!trimmed) {
      window.localStorage.removeItem(FRONTEND_HOST_KEY)
      return
    }
    window.localStorage.setItem(FRONTEND_HOST_KEY, trimmed)
  } catch {
    // ignore
  }
}

export function applyFrontendHostToUrl(url: URL, frontendHost: string): URL {
  const trimmed = frontendHost.trim()
  if (!trimmed) return url

  // Allow either "192.168.0.1:5173" or full "http(s)://host:port"
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    const base = new URL(trimmed)
    url.protocol = base.protocol
    url.host = base.host
    return url
  }

  url.host = trimmed
  return url
}

