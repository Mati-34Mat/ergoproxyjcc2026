import { z } from 'zod'
import { GROUNDING_VALUES, type Grounding, type RagMetadata } from '@/lib/rag/types'
import {
  FOLDER_OPERATIONS,
  FOLDER_OPERATION_LABELS,
  proposeFolderChangePlain,
  proposeFolderChangeSchema,
  type FolderOperation,
} from '@/lib/folder/schema'
import {
  FOLDER_EDGE_KINDS,
  FOLDER_EDGE_LABELS,
  FOLDER_NODE_LABELS,
  FOLDER_NODE_TYPES,
  isFolderNodeType,
  type FolderEdgeKind,
  type FolderNodeType,
} from '@/lib/folder/config'
import { ALIAS_MAX } from '@/lib/tree/config'
import {
  generateFileSchema,
  proposeDiagramSchema,
  type GenerateFileProposal,
  type DiagramProposal,
} from '@/lib/tools/schema'

export const CONVERSATION_MODES = ['theory', 'practice', 'free'] as const
export type ConversationMode = (typeof CONVERSATION_MODES)[number]

export const MODE_LABELS: Record<ConversationMode, string> = {
  theory: 'Teoría',
  practice: 'Práctica',
  free: 'Libre',
}

export const isConversationMode = (value: string): value is ConversationMode =>
  (CONVERSATION_MODES as readonly string[]).includes(value)

// Re-export de las constantes de la Carpeta: la UI (y el prompt) las toman de acá.
export {
  FOLDER_OPERATIONS,
  FOLDER_OPERATION_LABELS,
  FOLDER_EDGE_KINDS,
  FOLDER_EDGE_LABELS,
  FOLDER_NODE_LABELS,
  FOLDER_NODE_TYPES,
  isFolderNodeType,
}
export type { FolderOperation, FolderEdgeKind, FolderNodeType }

/**
 * Acciones que el agente puede PROPONER. Para sumar una nueva, agregarla acá y en `resolveAgentAction`.
 * El padre de la rama de historial no lo elige el modelo: es la rama donde se hizo la propuesta
 * (lo decide el servidor).
 */
export const proposeHistoryBranchSchema = z.object({
  type: z.literal('propose_history_branch'),
  alias: z.string().trim().min(1).max(ALIAS_MAX),
  description: z.string().trim().min(1).max(200),
})

/** Nodo nuevo en el mapa de dudas de la materia (QuestionNode). */
export const proposeQuestionNodeSchema = z.object({
  type: z.literal('propose_question_node'),
  parent_node_id: z.string().trim().max(64).nullable().default(null),
  title: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(200),
})

/**
 * Variante para el proveedor: OpenAI exige que todas las propiedades figuren en `required`,
 * y `.default(null)` las vuelve opcionales en el JSON Schema. El valor sigue siendo `string | null`.
 */
const proposeQuestionNodeGenerationSchema = z.object({
  type: z.literal('propose_question_node'),
  parent_node_id: z.string().trim().max(64).nullable(),
  title: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(200),
})

export const agentActionSchema = z.union([
  proposeHistoryBranchSchema,
  proposeQuestionNodeSchema,
  proposeFolderChangeSchema,
  proposeDiagramSchema,
  generateFileSchema,
])
export type BranchProposal = z.infer<typeof proposeHistoryBranchSchema>
export type QuestionNodeProposal = z.infer<typeof proposeQuestionNodeSchema>
export type AgentActionProposal = z.infer<typeof agentActionSchema>

export type { DiagramProposal, GenerateFileProposal }

/**
 * Lee el payload guardado de una propuesta. Migra en el camino las formas antiguas:
 * - rama con `title` en lugar de `alias` (previa al árbol de conversación);
 * - rama del mapa de dudas con `parent_node_id` (hoy `propose_question_node`).
 */
export function parseProposalPayload(payload: unknown): AgentActionProposal | null {
  const current = agentActionSchema.safeParse(payload)
  if (current.success) return current.data
  if (!payload || typeof payload !== 'object') return null
  const legacy = payload as {
    type?: unknown
    title?: unknown
    alias?: unknown
    description?: unknown
    parent_node_id?: unknown
  }
  if (legacy.type !== 'propose_history_branch') return null
  const description = typeof legacy.description === 'string' ? legacy.description : ''
  if (typeof legacy.parent_node_id === 'string' || legacy.parent_node_id === null) {
    const migrated = proposeQuestionNodeSchema.safeParse({
      type: 'propose_question_node',
      parent_node_id: legacy.parent_node_id ?? null,
      title: typeof legacy.title === 'string' ? legacy.title : '',
      description,
    })
    if (migrated.success) return migrated.data
  }
  if (typeof legacy.title === 'string') {
    const migrated = proposeHistoryBranchSchema.safeParse({
      type: legacy.type,
      alias: legacy.title.trim().slice(0, ALIAS_MAX),
      description,
    })
    return migrated.success ? migrated.data : null
  }
  return null
}

/**
 * Contrato estricto que se le exige al proveedor. Usa los objetos de cada acción y no una unión
 * discriminada: esa genera `oneOf` en el JSON Schema, que OpenAI rechaza en `response_format`
 * (HTTP 400). Con varias acciones se usa `z.union` (genera `anyOf`, que sí se acepta).
 */
export const agentResponseSchema = z.object({
  output: z.string().trim().min(1),
  description: z.string().trim().min(1).max(80),
  grounding: z.enum(GROUNDING_VALUES),
  actions: z.array(
    z.union([
      proposeHistoryBranchSchema,
      proposeQuestionNodeGenerationSchema,
      proposeFolderChangePlain,
      proposeDiagramSchema,
      generateFileSchema,
    ]),
  ),
})

/** Validación tolerante para recuperar JSON del texto crudo: las acciones se validan una por una. */
export const lenientResponseSchema = z.object({
  output: z.string().trim().min(1),
  description: z.string().trim().min(1).max(80).nullish(),
  grounding: z.enum(GROUNDING_VALUES).nullish(),
  actions: z.array(z.unknown()).nullish(),
})

export type AgentResponse = {
  output: string
  description: string | null
  /** Lo que declara el modelo; el servidor lo corrige contra las citas verificadas (ver `applyGrounding`). */
  grounding: Grounding
  actions: AgentActionProposal[]
}

/** Estrategia de recuperación aplicada a la respuesta del proveedor. */
export type RecoveryKind = 'none' | 'extracted_json' | 'plain_text'

/** Registro de la transformación de Fabric aplicada al contenido de la Carpeta (si hubo). */
export type FabricMetadata = {
  intents: string[]
  confidence: number
  material: string
  skill: string | null
  backend: string
  applied: number
}

/** Fuente de la búsqueda web (canal distinto del RAG). */
export type WebSource = {
  ref: number
  title: string
  url: string
  snippet: string
}

/** Registro de las herramientas ejecutadas en el turno (solo lectura y propuestas). */
export type ToolsMetadata = {
  webSearch: {
    configured: boolean
    ran: boolean
    error: string | null
    sources: WebSource[]
  }
  proposals: string[]
}

export type MessageMetadata = {
  model: string
  recovery: RecoveryKind
  droppedActions: number
  rag?: RagMetadata
  fabric?: FabricMetadata
  tools?: ToolsMetadata
}
