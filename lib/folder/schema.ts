import { z } from 'zod'
import {
  CONTENT_MAX,
  FOLDER_EDGE_KINDS,
  FOLDER_NODE_TYPES,
  REASON_MAX,
  TITLE_MAX,
} from '@/lib/folder/config'

export const FOLDER_OPERATIONS = [
  'create_node',
  'append_content',
  'replace_content',
  'relate_nodes',
  'create_exercise_with_solution',
] as const
export type FolderOperation = (typeof FOLDER_OPERATIONS)[number]

export const FOLDER_OPERATION_LABELS: Record<FolderOperation, string> = {
  create_node: 'Apunte nuevo',
  append_content: 'Agregar al apunte',
  replace_content: 'Reescribir el apunte',
  relate_nodes: 'Relacionar apuntes',
  create_exercise_with_solution: 'Ejercicio con resolución',
}

/**
 * Propuesta de cambio en la Carpeta (herramienta conceptual `propose_folder_change`).
 * Es plana y con campos anulables porque el proveedor exige un JSON Schema estricto:
 * - create_node: apunte nuevo (title, content_md; opcional node_type y target_node_id como padre).
 * - append_content: agrega content_md al apunte existente target_node_id.
 * - replace_content: reescribe el apunte target_node_id por completo.
 * - relate_nodes: relaciona target_node_id con related_node_id (edge_kind).
 * - create_exercise_with_solution: crea el ejercicio (content_md) y su resolución (solution_md).
 * Los ids de nodos los valida el servidor contra la materia: el modelo solo puede referirse
 * a apuntes que ya existen en la lista del prompt.
 */
const proposeFolderChangeBase = z.object({
  type: z.literal('propose_folder_change'),
  operation: z.enum(FOLDER_OPERATIONS),
  /** Nodo sobre el que se opera (actualizar, colgar un hijo, relacionar). */
  target_node_id: z.string().trim().max(64).nullable().default(null),
  /** Segundo nodo, solo para relate_nodes. */
  related_node_id: z.string().trim().max(64).nullable().default(null),
  edge_kind: z.enum(FOLDER_EDGE_KINDS).nullable().default(null),
  node_type: z.enum(FOLDER_NODE_TYPES).nullable().default(null),
  title: z.string().trim().max(TITLE_MAX).nullable().default(null),
  content_md: z.string().trim().max(CONTENT_MAX).nullable().default(null),
  /** Resolución, solo para create_exercise_with_solution. */
  solution_md: z.string().trim().max(CONTENT_MAX).nullable().default(null),
  /** Por qué vale la pena: se le muestra a la persona en la vista previa. */
  reason: z.string().trim().min(1).max(REASON_MAX),
})

/**
 * Versión sin refinamientos ni defaults: la que se le exige al proveedor (JSON Schema plano).
 * OpenAI exige que todas las propiedades figuren en `required`, y `.default(null)` las vuelve opcionales.
 */
export const proposeFolderChangePlain = z.object({
  type: z.literal('propose_folder_change'),
  operation: z.enum(FOLDER_OPERATIONS),
  target_node_id: z.string().trim().max(64).nullable(),
  related_node_id: z.string().trim().max(64).nullable(),
  edge_kind: z.enum(FOLDER_EDGE_KINDS).nullable(),
  node_type: z.enum(FOLDER_NODE_TYPES).nullable(),
  title: z.string().trim().max(TITLE_MAX).nullable(),
  content_md: z.string().trim().max(CONTENT_MAX).nullable(),
  solution_md: z.string().trim().max(CONTENT_MAX).nullable(),
  reason: z.string().trim().min(1).max(REASON_MAX),
})

/** Versión con la validación por operación, para parsear payloads guardados. */
export const proposeFolderChangeSchema = proposeFolderChangeBase.superRefine((value, ctx) => {
  const require = (field: keyof typeof value, message: string) => {
    if (value[field] === null || value[field] === undefined || value[field] === '') {
      ctx.addIssue({ code: 'custom', message, path: [field] })
    }
  }
  if (value.operation === 'create_node' || value.operation === 'create_exercise_with_solution') {
    require('title', 'Un nodo nuevo necesita título.')
    require('content_md', 'Un nodo nuevo necesita contenido.')
  }
  if (value.operation === 'create_exercise_with_solution') {
    require('solution_md', 'Falta la resolución del ejercicio.')
  }
  if (value.operation === 'append_content' || value.operation === 'replace_content') {
    require('target_node_id', 'Falta el apunte a actualizar.')
    require('content_md', 'Falta el contenido a escribir.')
  }
  if (value.operation === 'relate_nodes') {
    require('target_node_id', 'Falta el primer apunte a relacionar.')
    require('related_node_id', 'Falta el segundo apunte a relacionar.')
    if (value.target_node_id && value.target_node_id === value.related_node_id) {
      ctx.addIssue({
        code: 'custom',
        message: 'Un apunte no se relaciona consigo mismo.',
        path: ['related_node_id'],
      })
    }
  }
})

export type FolderProposal = z.infer<typeof proposeFolderChangeSchema>
