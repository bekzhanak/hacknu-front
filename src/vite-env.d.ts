/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LIVEBLOCKS_PUBLIC_KEY: string
  readonly VITE_ANTHROPIC_API_KEY: string
  readonly VITE_ANTHROPIC_MODEL?: string
  readonly VITE_AI_ENABLED?: string
  readonly VITE_ROOM_CREATE_CODE?: string
  readonly VITE_BRAINSTORM_API_BASE_URL?: string
  readonly VITE_FRONTEND_HOST?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
