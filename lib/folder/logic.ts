import {
  CONTENT_MAX,
  isFolderNodeType,
  PROMPT_INDEX_LIMIT,
  SIMILARITY_THRESHOLD,
  TITLE_MAX,
  type FolderNodeType,
} from '@/lib/folder/config'
import type { FolderProposal } from '@/lib/folder/schema'

export type NodeRef = { id: string; title: string; type: string }
export type EdgeRef = { fromId: string; toId: string; kind: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isNodeId = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value)

export function cleanTitle(raw: string) {
  return raw.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX)
}

const STOPWORDS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'y', 'e', 'o', 'en', 'un', 'una', 'al', 'a', 'para', 'por', 'con', 'que'])

/** Minúsculas, sin tildes ni signos: "Teorema de Bolzano" y "teorema de bolzano!" son lo mismo. */
export function normalizeTitle(title: string) {
  return title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokens(title: string) {
  return new Set(
    normalizeTitle(title)
      .split(' ')
      .filter((t) => t && !STOPWORDS.has(t)),
  )
}

/** 1 = mismo título; si un título contiene al otro (al menos dos palabras) se lo trata como casi igual. */
export function titleSimilarity(a: string, b: string) {
  const na = normalizeTitle(a)
  const nb = normalizeTitle(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let shared = 0
  for (const t of ta) if (tb.has(t)) shared += 1
  const jaccard = shared / (ta.size + tb.size - shared)
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta]
  const contained = small.size >= 2 && [...small].every((t) => large.has(t))
  return Math.max(jaccard, contained ? 0.8 : 0)
}

/** Los ejercicios se comparan solo con ejercicios; los apuntes teóricos, entre sí. */
const group = (type: string) => (type === 'exercise' || type === 'solution' ? type : 'knowledge')

export function findSimilarNode(nodes: NodeRef[], title: string, type: string): NodeRef | null {
  let best: NodeRef | null = null
  let bestScore = 0
  for (const node of nodes) {
    if (group(node.type) !== group(type)) continue
    const score = titleSimilarity(node.title, title)
    if (score >= SIMILARITY_THRESHOLD && score > bestScore) {
      best = node
      bestScore = score
    }
  }
  return best
}

/** Conectar `fromId` → `toId` como "contiene" crea un ciclo si `fromId` ya cuelga de `toId`. */
export function wouldCreateCycle(edges: EdgeRef[], fromId: string, toId: string) {
  if (fromId === toId) return true
  const children = new Map<string, string[]>()
  for (const e of edges) {
    if (e.kind !== 'contains') continue
    const list = children.get(e.fromId) ?? []
    list.push(e.toId)
    children.set(e.fromId, list)
  }
  const seen = new Set<string>()
  const stack = [toId]
  while (stack.length) {
    const current = stack.pop() as string
    if (current === fromId) return true
    if (seen.has(current)) continue
    seen.add(current)
    stack.push(...(children.get(current) ?? []))
  }
  return false
}

/** La relación "se relaciona con" es simétrica: se guarda siempre con el id menor primero. */
export const canonicalRelates = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a])

export function edgeExists(edges: EdgeRef[], a: string, b: string, kind: string) {
  if (kind === 'relates') {
    const [from, to] = canonicalRelates(a, b)
    return edges.some((e) => e.kind === 'relates' && e.fromId === from && e.toId === to)
  }
  return edges.some((e) => e.kind === kind && e.fromId === a && e.toId === b)
}

const compact = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase()

/** Agrega texto a un apunte sin repetir lo que ya contiene. `changed` es false si no había nada nuevo. */
export function mergeContent(existing: string, addition: string):
  | { ok: true; content: string; changed: boolean }
  | { ok: false; error: string } {
  const add = addition.trim()
  if (!add) return { ok: true, content: existing, changed: false }
  if (compact(existing).includes(compact(add))) return { ok: true, content: existing, changed: false }
  const content = existing.trim() ? `${existing.trimEnd()}\n\n${add}` : add
  if (content.length > CONTENT_MAX) {
    return { ok: false, error: `El apunte superaría el máximo de ${CONTENT_MAX} caracteres.` }
  }
  return { ok: true, content, changed: true }
}

export type Normalized = { ok: true; proposal: FolderProposal } | { ok: false; reason: string }

const blank = (): Omit<FolderProposal, 'operation' | 'reason'> => ({
  type: 'propose_folder_change',
  target_node_id: null,
  related_node_id: null,
  edge_kind: null,
  node_type: null,
  title: null,
  content_md: null,
  solution_md: null,
})

/**
 * Deja la propuesta del modelo coherente con el estado real de la Carpeta. Nunca confía en los ids del modelo:
 * los que no existen en el workspace se descartan. Si ya hay un apunte parecido, una creación se convierte en
 * una ampliación de ese apunte (reutilizar antes que duplicar).
 */
export function normalizeFolderProposal(
  proposal: FolderProposal,
  ctx: { nodes: NodeRef[]; edges: EdgeRef[] },
): Normalized {
  const byId = new Map(ctx.nodes.map((n) => [n.id, n]))
  const known = (id: string | null) => (id && byId.has(id) ? id : null)
  const reason = proposal.reason

  if (proposal.operation === 'create_node' || proposal.operation === 'create_exercise_with_solution') {
    const title = cleanTitle(proposal.title ?? '')
    if (!title) return { ok: false, reason: 'La propuesta no tiene título.' }
    const type: FolderNodeType = isFolderNodeType(proposal.node_type)
      ? proposal.node_type
      : proposal.operation === 'create_exercise_with_solution'
        ? 'exercise'
        : 'concept'
    const content = (proposal.content_md ?? '').trim()

    if (proposal.operation === 'create_node') {
      const similar = findSimilarNode(ctx.nodes, title, type)
      if (similar) {
        if (type === 'exercise' || type === 'solution' || !content) {
          return { ok: false, reason: `Ya existe «${similar.title}».` }
        }
        return normalizeFolderProposal(
          { ...blank(), operation: 'append_content', target_node_id: similar.id, content_md: content, reason },
          ctx,
        )
      }
    }

    return {
      ok: true,
      proposal: {
        ...blank(),
        operation: proposal.operation,
        node_type: type,
        title,
        content_md: content || null,
        target_node_id: known(proposal.target_node_id),
        solution_md:
          proposal.operation === 'create_exercise_with_solution'
            ? (proposal.solution_md?.trim() || null)
            : null,
        reason,
      },
    }
  }

  if (proposal.operation === 'append_content' || proposal.operation === 'replace_content') {
    const target = known(proposal.target_node_id)
    const content = (proposal.content_md ?? '').trim()
    if (!target) return { ok: false, reason: 'El apunte de destino no existe.' }
    if (!content) return { ok: false, reason: 'La propuesta no tiene contenido.' }
    return {
      ok: true,
      proposal: { ...blank(), operation: proposal.operation, target_node_id: target, content_md: content, reason },
    }
  }

  const a = known(proposal.target_node_id)
  const b = known(proposal.related_node_id)
  if (!a || !b || a === b) return { ok: false, reason: 'Los apuntes a relacionar no son válidos.' }
  const kind = proposal.edge_kind ?? 'relates'
  if (edgeExists(ctx.edges, a, b, kind)) return { ok: false, reason: 'Esos apuntes ya están relacionados.' }
  if (kind === 'contains' && wouldCreateCycle(ctx.edges, a, b)) {
    return { ok: false, reason: 'Esa relación crearía un ciclo.' }
  }
  return {
    ok: true,
    proposal: { ...blank(), operation: 'relate_nodes', target_node_id: a, related_node_id: b, edge_kind: kind, reason },
  }
}

const SAVE_VERB = /\b(agreg|guard|sum|anot|añad|anad|met|pon|sub|archiv)\w*/i

/** ¿El estudiante pidió guardar algo en la Carpeta? ("agregame esto a la carpeta", "guardalo en mi carpeta"). */
export function wantsFolderSave(text: string) {
  return /\bcarpeta\b/i.test(text) && SAVE_VERB.test(text)
}

/**
 * Propuesta de respaldo para cuando el estudiante pidió guardar y el modelo no la emitió: guarda la
 * última respuesta del tutor como apunte nuevo. Sigue siendo una PROPUESTA que la persona confirma.
 */
export function buildSaveProposal(markdown: string): FolderProposal | null {
  const content = markdown.trim().slice(0, CONTENT_MAX)
  if (!content) return null
  const firstLine = content
    .split('\n')
    .map((line) => line.replace(/^[\s#>*_`-]+|[\s*_`:]+$/g, '').trim())
    .find(Boolean)
  return {
    ...blank(),
    operation: 'create_node',
    node_type: 'concept',
    title: cleanTitle(firstLine ?? '') || 'Apunte de la conversación',
    content_md: content,
    reason: 'Lo pediste guardar desde el chat.',
  }
}

/** Índice compacto de la Carpeta para el prompt: id, tipo y título (el contenido no se envía). */
export function buildFolderIndex(nodes: NodeRef[]) {
  return nodes
    .slice(0, PROMPT_INDEX_LIMIT)
    .map((n) => `- ${n.id} · ${n.type} · ${n.title}`)
    .join('\n')
}
