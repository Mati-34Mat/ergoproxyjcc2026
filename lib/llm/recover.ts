import {
  agentActionSchema,
  lenientResponseSchema,
  type AgentActionProposal,
  type AgentResponse,
  type RecoveryKind,
} from '@/lib/llm/contract'

/**
 * Validación y recuperación de la respuesta del modelo. Módulo PURO (sin `server-only`)
 * para poder testearlo: garantiza que NINGUNA salida inválida llegue como respuesta
 * correcta. Las acciones siempre se validan una por una; las inválidas se descartan.
 */

function stripFences(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  return (fenced ? fenced[1] : text).trim()
}

export function extractJson(text: string): unknown {
  const candidate = stripFences(text)
  try {
    return JSON.parse(candidate)
  } catch {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start === -1 || end <= start) return undefined
    try {
      return JSON.parse(candidate.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
}

/**
 * Un `append_content` sin apunte de destino pero con título y contenido es un apunte nuevo
 * mal etiquetado (pasa cuando la Carpeta no tiene el tema). Se reetiqueta en vez de descartarlo.
 */
function relabelOrphanAppend(item: unknown): unknown {
  if (!item || typeof item !== 'object') return item
  const a = item as Record<string, unknown>
  const has = (v: unknown) => typeof v === 'string' && v.trim().length > 0
  if (
    a.type === 'propose_folder_change' &&
    a.operation === 'append_content' &&
    !has(a.target_node_id) &&
    has(a.title) &&
    has(a.content_md)
  ) {
    return { ...a, operation: 'create_node' }
  }
  return item
}

/** Valida cada acción por separado: las inválidas se descartan, nunca se ejecutan. */
export function validateActions(raw: unknown[]) {
  const valid: AgentActionProposal[] = []
  const issues: string[] = []
  let dropped = 0
  for (const original of raw) {
    const item = relabelOrphanAppend(original)
    const parsed = agentActionSchema.safeParse(item)
    if (parsed.success) valid.push(parsed.data)
    else {
      dropped += 1
      const type = (item as { type?: unknown } | null)?.type
      issues.push(`${typeof type === 'string' ? type : 'acción'}: ${parsed.error.issues.map((i) => i.message).slice(0, 3).join(' | ')}`)
    }
  }
  return { valid, dropped, issues }
}

/** Recupera una respuesta cuando el proveedor no cumplió el esquema. Devuelve null si no hay texto utilizable. */
export function recover(
  rawText: string | undefined,
): { response: AgentResponse; dropped: number; kind: RecoveryKind } | null {
  const text = rawText?.trim()
  if (!text) return null

  const json = extractJson(text)
  const lenient = lenientResponseSchema.safeParse(json)
  if (lenient.success) {
    const { valid, dropped } = validateActions(lenient.data.actions ?? [])
    return {
      response: {
        output: lenient.data.output,
        description: lenient.data.description ?? null,
        grounding: lenient.data.grounding ?? 'general',
        actions: valid,
      },
      dropped,
      kind: 'extracted_json',
    }
  }

  // Si el texto parece un JSON roto (aunque no empiece con llave), no se lo muestra
  // tal cual al estudiante: preferimos un error a exponer salida estructurada inválida.
  if (json !== undefined || /[{[]/.test(stripFences(text))) return null

  return {
    response: { output: text, description: null, grounding: 'general', actions: [] },
    dropped: 0,
    kind: 'plain_text',
  }
}
