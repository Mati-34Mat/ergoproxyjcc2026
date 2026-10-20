import 'server-only'

import { isUuid } from '@/lib/data/queries'
import { db } from '@/lib/db'
import { shortLabel } from '@/lib/tree/alias'
import { pathTo, visibleMessages, type TreeNode } from '@/lib/tree/compose'
import {
  ALIAS_MAX,
  MAX_DEPTH,
  MAX_NODES_PER_CONVERSATION,
  QUESTION_PREVIEW_CHARS,
  ROOT_ALIAS,
} from '@/lib/tree/config'

/**
 * Devuelve la raíz de la conversación, creándola si falta (conversaciones nuevas) y adoptando los mensajes
 * que todavía no pertenecen a ninguna rama. Es idempotente: el índice único parcial evita raíces duplicadas.
 */
export async function ensureRootNode(conversationId: string, userId: string) {
  const findRoot = () =>
    db.conversationNode.findFirst({
      where: { conversationId, userId, parentId: null },
      select: { id: true },
    })
  let root = await findRoot()
  if (!root) {
    const conversation = await db.conversation.findFirst({
      where: { id: conversationId, userId },
      select: { title: true },
    })
    if (!conversation) throw new Error('Conversación inexistente.')
    try {
      root = await db.conversationNode.create({
        data: { conversationId, userId, alias: ROOT_ALIAS, topic: conversation.title },
        select: { id: true },
      })
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error
      root = await findRoot()
    }
  }
  if (!root) throw new Error('No se pudo crear la rama inicial.')

  await db.message.updateMany({
    where: { conversationId, userId, nodeId: null },
    data: { nodeId: root.id },
  })
  await db.conversation.updateMany({
    where: { id: conversationId, userId, activeNodeId: null },
    data: { activeNodeId: root.id },
  })
  return root.id
}

export async function loadTree(conversationId: string, userId: string): Promise<TreeNode[]> {
  const rows = await db.conversationNode.findMany({
    where: { conversationId, userId },
    select: {
      id: true,
      parentId: true,
      alias: true,
      topic: true,
      contextSummary: true,
      summaryUpToSeq: true,
      inheritedSummary: true,
      anchorMessage: { select: { seq: true } },
    },
    orderBy: { createdAt: 'asc' },
  })
  return rows.map(({ anchorMessage, ...node }) => ({ ...node, anchorSeq: anchorMessage?.seq ?? null }))
}

/**
 * Elige la rama a mostrar: la pedida en la URL, si es válida; si no, la última activa; si no, la raíz.
 * Nunca confía en un id que no pertenezca a esta conversación.
 */
export function pickNodeId(
  nodes: TreeNode[],
  rootId: string,
  requested: string | null | undefined,
  active: string | null | undefined,
) {
  const ids = new Set(nodes.map((n) => n.id))
  if (requested && isUuid(requested) && ids.has(requested)) return requested
  if (active && ids.has(active)) return active
  return rootId
}

/** Alias de rama dentro del tope, cortado en una palabra entera para que se lea bien. */
function shortAlias(text: string) {
  return shortLabel(text, ALIAS_MAX)
}

/**
 * Rama interna con la que se continúa al elegir un nodo del historial de dudas. El nodo nació en una
 * respuesta del agente: si esa respuesta es la última de su rama, se sigue ahí; si no, se abre una rama
 * anclada en esa respuesta, que hereda el camino hasta ese punto y nada de lo que se habló después.
 *
 * Devuelve `nodeId: null` cuando el nodo no salió de esta conversación o su mensaje ya no existe: en ese
 * caso el nodo solo sirve como foco del prompt.
 */
export async function branchForQuestionNode(
  conversationId: string,
  userId: string,
  questionNodeId: string,
  tree: TreeNode[],
): Promise<{ ok: true; nodeId: string | null } | { ok: false; error: string }> {
  if (!isUuid(questionNodeId)) return { ok: true, nodeId: null }
  const questionNode = await db.questionNode.findFirst({
    where: { id: questionNodeId, userId, conversationId },
    select: {
      question: true,
      answerSummary: true,
      message: { select: { id: true, nodeId: true, seq: true } },
    },
  })
  const anchor = questionNode?.message
  const parent = anchor?.nodeId ? tree.find((n) => n.id === anchor.nodeId) : undefined
  if (!questionNode || !anchor || !parent) return { ok: true, nodeId: null }

  const later = await db.message.count({
    where: { conversationId, userId, nodeId: parent.id, seq: { gt: anchor.seq } },
  })
  if (later === 0) return { ok: true, nodeId: parent.id }

  // Si un intento anterior abrió la rama y el agente falló, se reusa en vez de duplicarla.
  const siblings = tree.filter((n) => n.parentId === parent.id)
  const emptyFork = siblings.find((n) => n.anchorSeq === anchor.seq)
  if (emptyFork) {
    const used = await db.message.count({ where: { conversationId, userId, nodeId: emptyFork.id } })
    if (used === 0) return { ok: true, nodeId: emptyFork.id }
  }

  if (tree.length >= MAX_NODES_PER_CONVERSATION) {
    return { ok: false, error: 'Esta sesión ya tiene el máximo de ramas. Empezá una sesión nueva.' }
  }
  if (pathTo(tree, parent.id).length > MAX_DEPTH) {
    return { ok: false, error: 'Esta rama ya está en el nivel máximo de profundidad.' }
  }

  const node = await db.conversationNode.create({
    data: {
      conversationId,
      userId,
      parentId: parent.id,
      anchorMessageId: anchor.id,
      alias: shortAlias(questionNode.question),
      topic: questionNode.answerSummary?.trim() || questionNode.question,
      position: siblings.length,
    },
    select: { id: true },
  })
  return { ok: true, nodeId: node.id }
}

/** Rama completa para mostrar o continuar: camino raíz→nodo y mensajes visibles con su origen. */
export async function loadBranch(
  conversationId: string,
  userId: string,
  nodeId: string,
  preloaded?: TreeNode[],
) {
  const nodes = preloaded ?? (await loadTree(conversationId, userId))
  const path = pathTo(nodes, nodeId)
  if (!path.length) throw new Error('La rama no existe en esta conversación.')

  const rows = await db.message.findMany({
    where: { conversationId, userId, nodeId: { in: path.map((n) => n.id) } },
    include: { agentActions: { orderBy: { createdAt: 'asc' } } },
    orderBy: { seq: 'asc' },
  })
  return { nodes, path, visible: visibleMessages(path, rows) }
}

export type MapNode = {
  id: string
  parentId: string | null
  alias: string
  topic: string
  messageCount: number
  hasSummary: boolean
  questions: { id: string; text: string }[]
}

/** Datos livianos para dibujar el mapa y buscar preguntas anteriores en cualquier rama. */
export async function listMapNodes(conversationId: string, userId: string): Promise<MapNode[]> {
  const [nodes, messages] = await Promise.all([
    db.conversationNode.findMany({
      where: { conversationId, userId },
      select: { id: true, parentId: true, alias: true, topic: true, contextSummary: true },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    }),
    db.message.findMany({
      where: { conversationId, userId, nodeId: { not: null }, role: { in: ['user', 'assistant'] } },
      select: { id: true, nodeId: true, role: true, content: true },
      orderBy: { seq: 'asc' },
    }),
  ])
  const byNode = new Map<string, MapNode>(
    nodes.map((n) => [
      n.id,
      {
        id: n.id,
        parentId: n.parentId,
        alias: n.alias,
        topic: n.topic,
        messageCount: 0,
        hasSummary: Boolean(n.contextSummary),
        questions: [],
      },
    ]),
  )
  for (const m of messages) {
    const node = m.nodeId ? byNode.get(m.nodeId) : undefined
    if (!node) continue
    node.messageCount += 1
    if (m.role === 'user') {
      node.questions.push({ id: m.id, text: m.content.slice(0, QUESTION_PREVIEW_CHARS) })
    }
  }
  return [...byNode.values()]
}
