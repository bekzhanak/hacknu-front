function envString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export const config = {
  frontendHost: envString((import.meta.env as any).VITE_FRONTEND_HOST).trim(),
  brainstormApiBaseUrl: envString((import.meta.env as any).VITE_BRAINSTORM_API_BASE_URL).trim(),
  liveblocksPublicKey: envString((import.meta.env as any).VITE_LIVEBLOCKS_PUBLIC_KEY).trim(),

  // Note: this is exposed to the browser by design in this hackathon setup.
  anthropicApiKey: envString((import.meta.env as any).VITE_ANTHROPIC_API_KEY).trim(),
  anthropicModel: envString((import.meta.env as any).VITE_ANTHROPIC_MODEL).trim() || undefined,

  aiEnabled: envString((import.meta.env as any).VITE_AI_ENABLED).trim() === 'true',
  roomCreateCode: envString((import.meta.env as any).VITE_ROOM_CREATE_CODE).trim() || undefined,
} as const

