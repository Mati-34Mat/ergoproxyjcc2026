'use server'

import { revalidatePath } from 'next/cache'
import { after } from 'next/server'
import { z } from 'zod'
import { isUuid } from '@/lib/data/queries'
import { nextNodePosition } from '@/lib/data/tree-layout'
import { db } from '@/lib/db'
import { MAX_NODES_PER_WORKSPACE } from '@/lib/folder/config'
import { buildSaveProposal, wantsFolderSave } from '@/lib/folder/logic'
import { loadFolderIndex, prepareFolderProposals } from '@/lib/folder/server'
import { AgentError, runAgent } from '@/lib/llm/agent'
import { isConversationMode, type ToolsMetadata } from '@/lib/llm/contract'
import { applyGrounding } from '@/lib/rag/ground'
import { retrieveContext } from '@/lib/rag/retrieve'
import { demoModeBlock, getUserId } from '@/lib/session'
import { getStudyPrioritiesForPrompt } from '@/lib/study/server'
import { classifyIntent } from '@/lib/jev/classify'
import { decideFabricSkill } from '@/lib/jev/skill-map'
import { applyFabricToProposals } from '@/lib/fabric/apply'
import { detectToolNeeds } from '@/lib/tools/intent'
import { executeReadTool } from '@/lib/tools/executor'
import { prepareToolProposals } from '@/lib/tools/prepare'
import { isWebSearchConfigured } from '@/lib/tools/web-search'
import {
  branchForQuestionNode,
  ensureRootNode,
  loadBranch,
  loadTree,
  pickNodeId,
} from '@/lib/tree/branch'
import { composeContext, inheritedSize, otherBranches, type BranchNote } from '@/lib/tree/compose'
import { INHERITED_COMPACT_CHARS, MAX_PROPOSALS_PER_MESSAGE } from '@/lib/tree/config'
import { compactOwnContext, ensureInheritedSummary } from '@/lib/tree/summarize'
import type { ActionResult } from '@/lib/types'

const contentSchema = z
  .string()
  .trim()
  .min(1, 'Escribí un mensaje.')
  .max(4000, 'El mensaje admite hasta 4000 caracteres.')

const DEFAULT_TITLE = 'Nueva conversación'
const MAX_SELECTED_FILES = 8
const MAX_QUESTION_NODES = 40
const SHORT_FOLLOW_UP_LENGTH = 60
/** Tope del título de un nodo del historial (ver `proposeQuestionNodeSchema`). */
const QUESTION_TITLE_MAX = 60
const CITATION_MARKERS = /\s?\[F\d+(?:\s*[,;]\s*F?\d+)*\]/g

const normalizeTitle = (title: string) => title.trim().toLocaleLowerCase('es')

type HistoryNodeInput = { parentId: string | null; title: string; summary: string | null }

/**
 * Crea los nodos del historial de dudas de este turno sin pedir confirmación: el historial es
 * el registro de lo que se preguntó, no un cambio sobre los apuntes. El padre se vuelve a leer
 * filtrando por userId, así que un id ajeno nunca cuelga un nodo de otro usuario.
 */
async function createHistoryNodes(
  tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
  ctx: { userId: string; conversationId: string; subjectId: string | null; messageId: string },
  nodes: HistoryNodeInput[],
) {
  for (const node of nodes) {
    const parent = node.parentId
      ? await tx.questionNode.findFirst({
          where: { id: node.parentId, userId: ctx.userId },
          select: { id: true, subjectId: true, posX: true, posY: true },
        })
      : null
    const subjectId = ctx.subjectId ?? parent?.subjectId ?? null
    const siblingCount = await tx.questionNode.count({
      where: parent
        ? { userId: ctx.userId, parentId: parent.id }
        : { userId: ctx.userId, parentId: null, subjectId },
    })
    await tx.questionNode.create({
      data: {
        userId: ctx.userId,
        question: node.title,
        answerSummary: node.summary,
        parentId: parent?.id ?? null,
        subjectId,
        conversationId: ctx.conversationId,
        messageId: ctx.messageId,
        ...nextNodePosition({ parent: parent ? { posX: parent.posX, posY: parent.posY } : null, siblingCount }),
      },
    })
  }
}

export async function sendMessage(
  conversationId: string,
  rawContent: string,
  rawFileIds: string[] = [],
  rawNodeId: string | null = null,
  rawFocusNodeId: string | null = null,
): Promise<ActionResult<{ proposedActions: number; nodeId: string }>> {
  const blocked = demoModeBlock()
  if (blocked) return blocked
  const userId = await getUserId()
  const parsed = contentSchema.safeParse(rawContent)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message }
  const content = parsed.data
  const selectedFileIds = [...new Set(rawFileIds)].filter(isUuid).slice(0, MAX_SELECTED_FILES)

  if (!isUuid(conversationId)) return { ok: false, error: 'No encontramos la conversación.' }
  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, userId },
    select: { id: true, title: true, mode: true, subjectId: true, activeNodeId: true },
  })
  if (!conversation) return { ok: false, error: 'No encontramos la conversación.' }
  const mode = isConversationMode(conversation.mode) ? conversation.mode : 'free'

  // La rama sale de la conversación del usuario: un id ajeno o inexistente cae a la rama activa.
  const rootId = await ensureRootNode(conversationId, userId)
  let tree = await loadTree(conversationId, userId)
  let nodeId = pickNodeId(tree, rootId, rawNodeId, conversation.activeNodeId)

  // Continuar desde un nodo del historial de dudas bifurca la conversación en la respuesta donde
  // nació ese nodo: el agente ve el camino hasta ahí y no lo que se habló después.
  if (rawFocusNodeId) {
    const fork = await branchForQuestionNode(conversationId, userId, rawFocusNodeId, tree)
    if (!fork.ok) return { ok: false, error: fork.error }
    if (fork.nodeId) {
      nodeId = fork.nodeId
      tree = await loadTree(conversationId, userId)
    }
  }

  let branch = await loadBranch(conversationId, userId, nodeId, tree)
  const target = branch.path[branch.path.length - 1]
  if (
    branch.path.length > 1 &&
    !target.inheritedSummary &&
    inheritedSize(branch.path, branch.visible) > INHERITED_COMPACT_CHARS
  ) {
    await ensureInheritedSummary(conversationId, userId, nodeId)
    branch = await loadBranch(conversationId, userId, nodeId, tree)
  }
  const context = composeContext(
    branch.path,
    branch.visible.filter((v) => v.message.role === 'user' || v.message.role === 'assistant'),
  )

  // Las citas de turnos anteriores se quitan: sus marcadores [F1] no existen en la búsqueda actual.
  const history: { role: 'user' | 'assistant'; content: string }[] = context.messages.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.role === 'assistant' ? m.content.replace(CITATION_MARKERS, '') : m.content,
  }))
  if (history[0]?.role === 'assistant') {
    history.unshift({ role: 'user', content: '(Continuación de la conversación de esta rama.)' })
  }
  history.push({ role: 'user', content })

  // Una repregunta corta ("¿y el paso 3?") se busca junto con la pregunta anterior de la MISMA rama.
  const lastUserQuestion = context.messages.findLast((m) => m.role === 'user')?.content
  const retrievalQuery =
    content.length < SHORT_FOLLOW_UP_LENGTH && lastUserQuestion
      ? `${lastUserQuestion}\n${content}`
      : content
  const retrieval = await retrieveContext({
    userId,
    subjectId: conversation.subjectId,
    query: retrievalQuery,
    selectedFileIds,
  })

  const folderIndex = await loadFolderIndex(userId, conversation.subjectId)

  // Dificultad estimada por tema de la Carpeta: pista para que el agente priorice
  // dónde escribir más. Es de solo lectura y nunca decide nada por sí sola.
  const studyPriorities = await getStudyPrioritiesForPrompt(userId, conversation.subjectId)

  // Historial de dudas de la materia: el agente propone nodos nuevos y elige de cuál cuelgan.
  const [questionNodes, sessionNodes, focusNode] = await Promise.all([
    db.questionNode.findMany({
      where: { userId, ...(conversation.subjectId ? { subjectId: conversation.subjectId } : {}) },
      select: { id: true, question: true },
      orderBy: { createdAt: 'desc' },
      take: MAX_QUESTION_NODES,
    }),
    db.questionNode.findMany({
      where: { userId, conversationId },
      select: {
        id: true,
        question: true,
        answerSummary: true,
        messageId: true,
        message: { select: { nodeId: true, seq: true } },
      },
      orderBy: { createdAt: 'asc' },
    }),
    rawFocusNodeId && isUuid(rawFocusNodeId)
      ? db.questionNode.findFirst({
          where: { id: rawFocusNodeId, userId },
          select: { id: true, question: true },
        })
      : Promise.resolve(null),
  ])

  // Nodo actual: el último que nació en el camino de esta rama, padre natural de la próxima duda.
  const visibleIds = new Set(branch.visible.map((v) => v.message.id))
  const currentNode =
    sessionNodes.findLast((n) => n.messageId !== null && visibleIds.has(n.messageId)) ?? null
  for (const node of [currentNode, focusNode]) {
    if (node && !questionNodes.some((n) => n.id === node.id)) {
      questionNodes.push({ id: node.id, question: node.question })
    }
  }

  // Las otras ramas se describen con las dudas que se resolvieron en cada una.
  const notesByBranch = new Map<string, BranchNote[]>()
  for (const n of sessionNodes) {
    const branchId = n.message?.nodeId
    if (!branchId) continue
    const text = n.answerSummary ? `${n.question} (${n.answerSummary})` : n.question
    notesByBranch.set(branchId, [...(notesByBranch.get(branchId) ?? []), { seq: n.message!.seq, text }])
  }

  // Herramientas del turno. La búsqueda web es de SOLO LECTURA: se ejecuta acá, antes
  // del agente, y sus resultados entran al prompt como un canal distinto del RAG. Si no
  // hay proveedor configurado, NO se busca ni se afirma que se buscó.
  const toolNeeds = detectToolNeeds(content)
  let webOutcome = undefined
  if (toolNeeds.web && toolNeeds.webQuery) {
    if (isWebSearchConfigured()) {
      const outcome = await executeReadTool({
        tool: 'web_search',
        args: { query: toolNeeds.webQuery, limit: 5 },
        userId,
        conversationId,
        messageId: null,
      })
      webOutcome = outcome.web
    } else {
      // Deja registro de que se pidió y no había proveedor (nunca se miente al usuario).
      webOutcome = { configured: false as const, results: [] as [], error: null }
      await executeReadTool({
        tool: 'web_search',
        args: { query: toolNeeds.webQuery, limit: 5 },
        userId,
        conversationId,
        messageId: null,
      })
    }
  }

  // Si el modelo falla no se guarda nada: el usuario conserva su borrador y puede reintentar.
  // Jev (clasificador de intención) corre en paralelo con el agente: su resultado sólo se
  // usa para elegir la skill de Fabric que transforma el contenido de la Carpeta.
  let result
  let jev
  try {
    ;[result, jev] = await Promise.all([
      runAgent({
        mode,
        history,
        folder: {
          canPropose: folderIndex.nodes.length < MAX_NODES_PER_WORKSPACE,
          nodes: folderIndex.nodes,
          priorities: studyPriorities,
        },
        questions: { canPropose: true, nodes: questionNodes, currentId: currentNode?.id ?? null },
        rag: retrieval,
        branch: {
          alias: target.alias,
          topic: target.topic,
          isRoot: branch.path.length === 1,
          summaries: context.summaries,
          otherBranches: otherBranches(tree, branch.path, notesByBranch),
          truncated: context.truncated,
        },
        focusNode,
        tools: { web: webOutcome, wantsFile: toolNeeds.file, wantsDiagram: toolNeeds.diagram },
      }),
      classifyIntent(content, lastUserQuestion),
    ])
  } catch (error) {
    if (error instanceof AgentError) return { ok: false, error: error.message }
    return { ok: false, error: 'No pudimos generar la respuesta. Probá de nuevo.' }
  }

  const proposed = result.response.actions
  // Los nodos del historial de dudas solo pueden colgar de nodos del propio usuario; el resto se descarta.
  const questionParentIds = [
    ...new Set(
      proposed.flatMap((a) =>
        a.type === 'propose_question_node' && a.parent_node_id ? [a.parent_node_id] : [],
      ),
    ),
  ].filter(isUuid)
  const ownedParents = new Set(
    questionParentIds.length
      ? (
          await db.questionNode.findMany({
            where: { id: { in: questionParentIds }, userId },
            select: { id: true },
          })
        ).map((n) => n.id)
      : [],
  )
  // También se descartan los repetidos (entre sí o con nodos que ya existen) y los que excedan el tope.
  // El modelo nombra mejor la duda en `description` que en el título del nodo (tiende a titular el
  // tema que vendría después): el primer nodo propuesto toma ese alias si entra en el tope.
  const answerAlias = result.response.description?.trim().replace(/[.\s]+$/, '') ?? ''
  const takenTitles = new Set(questionNodes.map((n) => normalizeTitle(n.question)))
  // Con dos o más dudas en el mensaje, el alias de `description` cubre la respuesta entera y no
  // una sola duda: cada nodo conserva su propio título.
  const proposedQuestionCount = proposed.filter((p) => p.type === 'propose_question_node').length
  // Sin padre válido (null o id inexistente) el nodo cuelga de la duda anterior de la rama, para que
  // los nodos de un mismo mensaje nunca queden sueltos; solo el primero de una sesión es raíz.
  const defaultParentId = focusNode?.id ?? currentNode?.id ?? null
  const questionActions = proposed
    .flatMap((a, index) => {
      if (a.type !== 'propose_question_node') return []
      const parentId =
        a.parent_node_id !== null && ownedParents.has(a.parent_node_id) ? a.parent_node_id : defaultParentId
      const isFirst = proposed.findIndex((p) => p.type === 'propose_question_node') === index
      const useAlias =
        isFirst && proposedQuestionCount === 1 && answerAlias && answerAlias.length <= QUESTION_TITLE_MAX
      const action = { ...a, parent_node_id: parentId, ...(useAlias ? { title: answerAlias } : {}) }
      const key = normalizeTitle(action.title)
      if (takenTitles.has(key)) return []
      takenTitles.add(key)
      return [action]
    })
    .slice(0, MAX_PROPOSALS_PER_MESSAGE)

  // Cada mensaje deja al menos un nodo: si el modelo no aportó ninguno válido (repregunta, título
  // repetido, padre inexistente, acción descartada), el nodo sale de la duda de la persona.
  const historyNodes: HistoryNodeInput[] = questionActions.map((a) => ({
    parentId: a.parent_node_id,
    title: a.title,
    summary: a.description,
  }))
  if (historyNodes.length === 0) {
    const questionText = content.replace(/[¿?]/g, '').replace(/\s+/g, ' ').trim() || content
    const fallbackTitle =
      [answerAlias, questionText].find(
        (t) => t && t.length <= QUESTION_TITLE_MAX && !takenTitles.has(normalizeTitle(t)),
      ) ?? questionText.slice(0, QUESTION_TITLE_MAX).trim()
    historyNodes.push({
      parentId: focusNode?.id ?? currentNode?.id ?? null,
      title: fallbackTitle,
      summary: result.response.description ?? null,
    })
  }

  // Las de Carpeta se validan contra los apuntes reales: ids inventados y duplicados se descartan acá.
  let folderPrepared = await prepareFolderProposals(
    userId,
    conversation.subjectId,
    proposed.filter((a) => a.type === 'propose_folder_change'),
  )
  // Si pidió guardar y el modelo no emitió una propuesta válida, se arma una con la última
  // respuesta del tutor. Sigue siendo una propuesta: la persona la confirma.
  let savedFallback = false
  const lastAssistantText = context.messages
    .findLast((m) => m.role === 'assistant')
    ?.content.replace(CITATION_MARKERS, '')
  if (
    wantsFolderSave(content) &&
    folderPrepared.valid.length === 0 &&
    folderIndex.nodes.length < MAX_NODES_PER_WORKSPACE &&
    lastAssistantText
  ) {
    const fallback = buildSaveProposal(lastAssistantText)
    if (fallback) {
      folderPrepared = await prepareFolderProposals(userId, conversation.subjectId, [fallback])
      savedFallback = folderPrepared.valid.length > 0
    }
  }

  // Jev decide qué skill de Fabric conviene para transformar el contenido que irá a la
  // Carpeta. El usuario sigue aprobando y editando: acá sólo se prepara el borrador.
  const skillDecision = decideFabricSkill(jev)
  const sourceNote =
    retrieval.status === 'ok' && retrieval.sources.length
      ? `Basado en tus documentos (${retrieval.sources.length} fragmento(s) consultado(s)).`
      : null
  const fabricApplied = await applyFabricToProposals(folderPrepared.valid, skillDecision.skill, {
    material: skillDecision.material,
    sourceNote,
  })

  // Propuestas de herramientas (diagrama, archivo): el servidor valida el esquema, el
  // código Mermaid y el contenido del archivo antes de ofrecérselas a la persona.
  const toolProposals = prepareToolProposals(
    proposed.filter((a) => a.type === 'propose_diagram' || a.type === 'generate_file'),
  )

  // Los nodos del historial ya no son propuestas: se crean solos al guardar el mensaje.
  const actions = [...fabricApplied.proposals, ...toolProposals.valid]
  const droppedActions =
    result.metadata.droppedActions +
    (proposed.length - actions.length - questionActions.length) +
    toolProposals.dropped
  const grounded = applyGrounding(
    savedFallback
      ? 'Te dejé una propuesta para guardar lo anterior en la Carpeta. Revisala y confirmala.'
      : result.response.output,
    result.response.grounding,
    retrieval,
  )
  const fabricMeta = fabricApplied.results.length
    ? {
        intents: [jev.intent],
        confidence: jev.confidence,
        material: skillDecision.material,
        skill: skillDecision.skill,
        backend: fabricApplied.results[0].backend,
        applied: fabricApplied.results.length,
      }
    : undefined
  const toolsMeta: ToolsMetadata | undefined =
    webOutcome || toolProposals.valid.length
      ? {
          webSearch: {
            configured: webOutcome?.configured ?? false,
            ran: Boolean(webOutcome?.configured && !webOutcome.error),
            error: webOutcome?.error ?? null,
            sources: (webOutcome?.results ?? []).map((r, i) => ({ ref: i + 1, ...r })),
          },
          proposals: toolProposals.valid.map((a) => a.type),
        }
      : undefined
  const newTitle =
    conversation.title === DEFAULT_TITLE && result.response.description
      ? result.response.description
      : conversation.title

  await db.$transaction(async (tx) => {
    await tx.message.create({ data: { conversationId, userId, nodeId, role: 'user', content } })
    const reply = await tx.message.create({
      data: {
        conversationId,
        userId,
        nodeId,
        role: 'assistant',
        content: grounded.output,
        description: result.response.description,
        metadata: { ...result.metadata, droppedActions, rag: grounded.rag, fabric: fabricMeta, tools: toolsMeta },
      },
      select: { id: true },
    })
    await createHistoryNodes(
      tx,
      { userId, conversationId, subjectId: conversation.subjectId, messageId: reply.id },
      historyNodes,
    )
    if (actions.length) {
      await tx.agentAction.createMany({
        data: actions.map((a) => ({
          userId,
          conversationId,
          messageId: reply.id,
          type: a.type,
          payload: a,
        })),
      })
    }
    if (newTitle !== conversation.title) {
      await tx.conversationNode.updateMany({
        where: { conversationId, userId, parentId: null },
        data: { topic: newTitle },
      })
    }
    await tx.conversation.updateMany({
      where: { id: conversationId, userId },
      data: { title: newTitle, activeNodeId: nodeId, updatedAt: new Date() },
    })
  })

  // El resumen se genera después de responder para no sumar latencia al turno.
  after(() => compactOwnContext(nodeId, userId))

  revalidatePath('/', 'layout')
  return { ok: true, data: { proposedActions: actions.length, nodeId } }
}
