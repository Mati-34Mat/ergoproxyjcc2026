'use server'

import { revalidatePath } from 'next/cache'
import { isUuid } from '@/lib/data/queries'
import { nextNodePosition } from '@/lib/data/tree-layout'
import { db } from '@/lib/db'
import { applyFolderProposal, FolderError, type FolderSourceRef } from '@/lib/folder/server'
import { isConversationMode, parseProposalPayload } from '@/lib/llm/contract'
import { materializeGeneratedFile } from '@/lib/tools/generate-file'
import { validateMermaid } from '@/lib/tools/mermaid'
import { demoModeBlock, getUserId } from '@/lib/session'
import { loadTree } from '@/lib/tree/branch'
import { pathTo } from '@/lib/tree/compose'
import { MAX_DEPTH, MAX_NODES_PER_CONVERSATION } from '@/lib/tree/config'
import type { ActionResult } from '@/lib/types'

const ALREADY_RESOLVED = 'Esta acción ya fue resuelta.'

type ActionRow = {
  id: string
  conversationId: string
  messageId: string
  message: { id: string; nodeId: string | null }
  conversation: { subjectId: string | null; title: string }
}

/**
 * Confirma o descarta una acción propuesta por el agente.
 *
 * El agente nunca escribe solo: deja la propuesta en estado 'proposed' y acá se
 * revalida todo (que los nodos sigan existiendo y sean del usuario) antes de
 * ejecutarla. Descartar no toca ni el historial ni la Carpeta.
 */
export async function resolveAgentAction(
  actionId: string,
  decision: 'accept' | 'dismiss',
): Promise<ActionResult<{ nodeId?: string }>> {
  const blocked = demoModeBlock()
  if (blocked) return blocked
  const userId = await getUserId()
  if (!isUuid(actionId)) return { ok: false, error: 'No encontramos la acción.' }

  const action = await db.agentAction.findFirst({
    where: { id: actionId, userId },
    include: {
      message: { select: { id: true, nodeId: true } },
      conversation: { select: { subjectId: true, title: true } },
    },
  })
  if (!action) return { ok: false, error: 'No encontramos la acción.' }
  if (action.status !== 'proposed') return { ok: false, error: ALREADY_RESOLVED }

  if (decision === 'dismiss') {
    const { count } = await db.agentAction.updateMany({
      where: { id: actionId, userId, status: 'proposed' },
      data: { status: 'dismissed', resolvedAt: new Date() },
    })
    if (count === 0) return { ok: false, error: ALREADY_RESOLVED }
    revalidatePath('/', 'layout')
    return { ok: true }
  }

  const proposal = parseProposalPayload(action.payload)
  if (!proposal) return { ok: false, error: 'La acción propuesta no es válida.' }

  if (proposal.type === 'propose_folder_change') {
    return acceptFolderChange(userId, action as ActionRow, proposal)
  }
  if (proposal.type === 'propose_question_node') {
    return acceptQuestionNode(userId, action as ActionRow, proposal)
  }
  if (proposal.type === 'propose_diagram') {
    return acceptDiagram(userId, action as ActionRow, proposal)
  }
  if (proposal.type === 'generate_file') {
    return acceptGeneratedFile(userId, action as ActionRow, proposal)
  }
  return acceptConversationBranch(userId, action as ActionRow, proposal)
}

/** Marca la acción como aceptada. Devuelve false si otra pestaña se adelantó. */
async function claim(
  tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
  userId: string,
  actionId: string,
) {
  const { count } = await tx.agentAction.updateMany({
    where: { id: actionId, userId, status: 'proposed' },
    data: { status: 'accepted', resolvedAt: new Date() },
  })
  return count > 0
}

/**
 * Abre una rama nueva en el árbol de la conversación. El nodo padre no lo decide
 * el modelo: es la rama donde se hizo la propuesta (se lee del mensaje).
 */
async function acceptConversationBranch(
  userId: string,
  action: ActionRow,
  proposal: { alias: string; description: string },
): Promise<ActionResult<{ nodeId?: string }>> {
  const parentId = action.message.nodeId
  if (!parentId) return { ok: false, error: 'La rama de origen ya no existe. Descartá la propuesta.' }

  const tree = await loadTree(action.conversationId, userId)
  const parentPath = pathTo(tree, parentId)
  if (!parentPath.length) return { ok: false, error: 'La rama de origen ya no existe. Descartá la propuesta.' }
  if (tree.length >= MAX_NODES_PER_CONVERSATION) {
    return { ok: false, error: 'Esta conversación ya tiene el máximo de ramas.' }
  }
  if (parentPath.length > MAX_DEPTH) {
    return { ok: false, error: 'Esta rama ya está en el nivel máximo de profundidad.' }
  }
  const siblings = tree.filter((n) => n.parentId === parentId)
  const taken = proposal.alias.toLocaleLowerCase('es')
  if (siblings.some((n) => n.alias.toLocaleLowerCase('es') === taken)) {
    return { ok: false, error: 'Ya existe una rama con ese nombre. Descartá la propuesta.' }
  }

  const nodeId = await db.$transaction(async (tx) => {
    if (!(await claim(tx, userId, action.id))) return null
    const node = await tx.conversationNode.create({
      data: {
        conversationId: action.conversationId,
        userId,
        parentId,
        anchorMessageId: action.messageId,
        alias: proposal.alias,
        topic: proposal.description,
        position: siblings.length,
      },
      select: { id: true },
    })
    await tx.agentAction.update({ where: { id: action.id }, data: { resultNodeId: node.id } })
    await tx.conversation.updateMany({
      where: { id: action.conversationId, userId },
      data: { activeNodeId: node.id },
    })
    return node.id
  })
  if (!nodeId) return { ok: false, error: ALREADY_RESOLVED }

  revalidatePath('/', 'layout')
  return { ok: true, data: { nodeId } }
}

/** Agrega un nodo al mapa de dudas de la materia (QuestionNode). */
async function acceptQuestionNode(
  userId: string,
  action: ActionRow,
  proposal: { parent_node_id: string | null; title: string; description: string },
): Promise<ActionResult<{ nodeId?: string }>> {
  const { parent_node_id, title, description } = proposal

  let parentSubjectId: string | null = null
  let parentPosition: { posX: number; posY: number } | null = null
  if (parent_node_id) {
    if (!isUuid(parent_node_id)) return { ok: false, error: 'La acción propuesta no es válida.' }
    const parent = await db.questionNode.findFirst({
      where: { id: parent_node_id, userId },
      select: { subjectId: true, posX: true, posY: true },
    })
    if (!parent) return { ok: false, error: 'El nodo padre ya no existe. Descartá la propuesta.' }
    parentSubjectId = parent.subjectId
    parentPosition = { posX: parent.posX, posY: parent.posY }
  }

  const nodeSubjectId = action.conversation.subjectId ?? parentSubjectId
  const siblingCount = await db.questionNode.count({
    where: parent_node_id
      ? { userId, parentId: parent_node_id }
      : { userId, parentId: null, conversationId: action.conversationId },
  })
  const position = nextNodePosition({ parent: parentPosition, siblingCount })

  const nodeId = await db.$transaction(async (tx) => {
    if (!(await claim(tx, userId, action.id))) return null
    const node = await tx.questionNode.create({
      data: {
        userId,
        question: title,
        answerSummary: description,
        parentId: parent_node_id,
        subjectId: nodeSubjectId,
        conversationId: action.conversationId,
        messageId: action.messageId,
        ...position,
      },
      select: { id: true },
    })
    await tx.agentAction.update({ where: { id: action.id }, data: { resultNodeId: node.id } })
    return node.id
  })
  if (!nodeId) return { ok: false, error: ALREADY_RESOLVED }

  revalidatePath('/', 'layout')
  return { ok: true, data: { nodeId } }
}

/**
 * Ejecuta un cambio en la Carpeta ya autorizado por la persona.
 *
 * Todo lo que el agente nombró se vuelve a buscar acá filtrando por userId: un
 * id inventado o ajeno hace fallar la operación en lugar de tocar datos de otro.
 */
async function acceptFolderChange(
  userId: string,
  action: ActionRow,
  proposal: Parameters<typeof applyFolderProposal>[3],
): Promise<ActionResult<{ nodeId?: string }>> {
  const subjectId = action.conversation.subjectId
  if (!subjectId) {
    return { ok: false, error: 'La conversación no pertenece a una materia, así que no hay Carpeta.' }
  }

  const historyNode = action.message.nodeId
    ? await db.conversationNode.findFirst({
        where: { id: action.message.nodeId, conversationId: action.conversationId, userId },
        select: { id: true, alias: true },
      })
    : null
  const source: FolderSourceRef = {
    conversationId: action.conversationId,
    messageId: action.message.id,
    historyNodeId: historyNode?.id ?? null,
    questionNodeId: null,
    label: historyNode ? `${action.conversation.title} › ${historyNode.alias}` : action.conversation.title,
  }

  try {
    const folderNodeId = await db.$transaction(async (tx) => {
      if (!(await claim(tx, userId, action.id))) return null
      const { nodeId } = await applyFolderProposal(tx, userId, subjectId, proposal, source)
      await tx.agentAction.update({ where: { id: action.id }, data: { resultNodeId: nodeId } })
      return nodeId
    })
    if (!folderNodeId) return { ok: false, error: ALREADY_RESOLVED }
    revalidatePath('/', 'layout')
    return { ok: true, data: { nodeId: folderNodeId } }
  } catch (error) {
    if (error instanceof FolderError) return { ok: false, error: error.message }
    throw error
  }
}

export async function setConversationMode(
  conversationId: string,
  mode: string,
): Promise<ActionResult> {
  const blocked = demoModeBlock()
  if (blocked) return blocked
  const userId = await getUserId()
  if (!isUuid(conversationId)) return { ok: false, error: 'No encontramos la conversación.' }
  if (!isConversationMode(mode)) return { ok: false, error: 'Modo inválido.' }
  const { count } = await db.conversation.updateMany({
    where: { id: conversationId, userId },
    data: { mode },
  })
  if (count === 0) return { ok: false, error: 'No encontramos la conversación.' }
  revalidatePath('/', 'layout')
  return { ok: true }
}

/** Cambia la rama que se muestra y con la que se continúa. Solo acepta nodos de esta conversación. */
export async function setActiveNode(
  conversationId: string,
  nodeId: string,
): Promise<ActionResult> {
  const blocked = demoModeBlock()
  if (blocked) return blocked
  const userId = await getUserId()
  if (!isUuid(conversationId) || !isUuid(nodeId)) {
    return { ok: false, error: 'No encontramos la rama.' }
  }
  const node = await db.conversationNode.findFirst({
    where: { id: nodeId, conversationId, userId },
    select: { id: true },
  })
  if (!node) return { ok: false, error: 'No encontramos la rama.' }
  await db.conversation.updateMany({
    where: { id: conversationId, userId },
    data: { activeNodeId: nodeId },
  })
  revalidatePath('/', 'layout')
  return { ok: true }
}

/**
 * Guarda un diagrama propuesto como apunte de la Carpeta. Revalida la sintaxis
 * Mermaid (pudo cambiar desde la propuesta) y exige un workspace (materia).
 */
async function acceptDiagram(
  userId: string,
  action: ActionRow,
  proposal: { title: string; source: string },
): Promise<ActionResult<{ nodeId?: string }>> {
  const subjectId = action.conversation.subjectId
  if (!subjectId) {
    return { ok: false, error: 'La conversación no pertenece a una materia, así que no hay Carpeta.' }
  }
  const check = validateMermaid(proposal.source)
  if (!check.ok) return { ok: false, error: 'El diagrama ya no es válido. Descartá la propuesta.' }

  const historyNode = action.message.nodeId
    ? await db.conversationNode.findFirst({
        where: { id: action.message.nodeId, conversationId: action.conversationId, userId },
        select: { id: true, alias: true },
      })
    : null
  const source: FolderSourceRef = {
    conversationId: action.conversationId,
    messageId: action.message.id,
    historyNodeId: historyNode?.id ?? null,
    questionNodeId: null,
    label: historyNode ? `${action.conversation.title} › ${historyNode.alias}` : action.conversation.title,
  }

  const nodeId = await db.$transaction(async (tx) => {
    if (!(await claim(tx, userId, action.id))) return null
    const count = await tx.folderNode.count({ where: { userId, subjectId } })
    const node = await tx.folderNode.create({
      data: {
        userId,
        subjectId,
        type: 'note',
        title: proposal.title.slice(0, 120),
        contentMd: `\`\`\`mermaid\n${check.source}\n\`\`\``,
        origin: 'ai',
        ...nextNodePosition({ parent: null, siblingCount: count }),
      },
      select: { id: true },
    })
    await tx.folderSource.create({
      data: {
        nodeId: node.id,
        userId,
        conversationId: source.conversationId,
        messageId: source.messageId,
        historyNodeId: source.historyNodeId,
        questionNodeId: source.questionNodeId,
        label: source.label.slice(0, 200),
      },
    })
    await tx.agentAction.update({ where: { id: action.id }, data: { resultNodeId: node.id } })
    return node.id
  })
  if (!nodeId) return { ok: false, error: ALREADY_RESOLVED }

  revalidatePath('/', 'layout')
  return { ok: true, data: { nodeId } }
}

/**
 * Genera el archivo descargable: sube el contenido real a Blob (o lo guarda en la
 * base) y registra el `GeneratedFile`. Nunca devuelve un enlace ficticio.
 */
async function acceptGeneratedFile(
  userId: string,
  action: ActionRow,
  proposal: { format: 'md' | 'csv' | 'txt'; file_name: string; content: string },
): Promise<ActionResult<{ nodeId?: string }>> {
  // Reclama la acción ANTES de materializar: si dos pestañas aceptan a la vez, solo
  // una gana y se evita crear dos archivos (y dos blobs) para la misma propuesta.
  const claimed = await db.$transaction((tx) => claim(tx, userId, action.id))
  if (!claimed) return { ok: false, error: ALREADY_RESOLVED }

  const result = await materializeGeneratedFile({
    userId,
    conversationId: action.conversationId,
    messageId: action.message.id,
    name: proposal.file_name,
    format: proposal.format,
    content: proposal.content,
  })
  if (!result.ok) {
    // Si no se pudo generar, se libera la acción para que se pueda reintentar.
    await db.agentAction.updateMany({
      where: { id: action.id, userId, status: 'accepted' },
      data: { status: 'proposed', resolvedAt: null },
    })
    return { ok: false, error: result.error }
  }

  revalidatePath('/', 'layout')
  return { ok: true }
}
