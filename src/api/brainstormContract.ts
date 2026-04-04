export const BRAINSTORM_CONTRACT_VERSION = 1 as const

export type BrainstormContractVersion = typeof BRAINSTORM_CONTRACT_VERSION

export type CanvasShapeSummary = {
  id: string
  type: string
  x: number
  y: number
  text?: string
}

export type CanvasSnapshot = {
  shapes: CanvasShapeSummary[]
}

export type AutocompleteRequest = {
  contractVersion: BrainstormContractVersion
  roomId: string
  snapshot: CanvasSnapshot
  hint?: string
  maxNewShapes?: number
}

export type CanvasCommand =
  | {
      action: 'create'
      id: `shape:${string}` | string
      shapeType: 'note'
      x: number
      y: number
      text: string
    }
  | {
      action: 'update'
      id: `shape:${string}` | string
      text?: string
      x?: number
      y?: number
    }
  | {
      action: 'delete'
      id: `shape:${string}` | string
    }

export type AutocompleteResponse = {
  contractVersion: BrainstormContractVersion
  commands: CanvasCommand[]
  // Optional: when using the Python Canvas Agent Service backend.
  changeId?: string
  operationsCount?: number
  reasoning?: string
}
