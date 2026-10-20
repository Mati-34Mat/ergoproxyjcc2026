'use server'

import { revalidatePath } from 'next/cache'
import { after } from 'next/server'
import { z } from 'zod'
import { isUuid } from '@/lib/data/queries'
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
import { ensureRootNode, loadBranch, loadTree, pickNodeId } from '@/lib/tree/branch'
import { composeContext, inheritedSize } from '@/lib/tree/compose'
import {
  INHERITED_COMPACT_CHARS,
  MAX_DEPTH,
  MAX_NODES_PER_CONVERSATION,
  MAX_PROPOSALS_PER_MESSAGE,
} from '@/lib/tree/config'
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
const CITATION_MARKERS = /\s?\[F\d+(?:\s*[,;]\s*F?\d+)*\]/g

const normalizeAlias = (alias: string) => alias.trim().toLocaleLowerCase('es')

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
  const tree = await loadTree(conversationId, userId)
  const nodeId = pickNodeId(tree, rootId, rawNodeId, conversation.activeNodeId)

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

  const existingChildAliases = tree.filter((n) => n.parentId === nodeId).map((n) => n.alias)
  const canPropose =
    tree.length < MAX_NODES_PER_CONVERSATION && branch.path.length <= MAX_DEPTH

  const folderIndex = await loadFolderIndex(userId, conversation.subjectId)

  // Dificultad estimada por tema de la Carpeta: pista para que el agente priorice
  // dónde escribir más. Es de solo lectura y nunca decide nada por sí sola.
  const studyPriorities = await getStudyPrioritiesForPrompt(userId, conversation.subjectId)

  // Mapa de dudas de la materia: el agente puede proponer nodos nuevos colgando de uno existente.
  const [questionNodes, focusNode] = await Promise.all([
    db.questionNode.findMany({
      where: { userId, ...(conversation.subjectId ? { subjectId: conversation.subjectId } : {}) },
      select: { id: true, question: true },
      orderBy: { createdAt: 'desc' },
      take: MAX_QUESTION_NODES,
    }),
    rawFocusNodeId && isUuid(rawFocusNodeId)
      ? db.questionNode.findFirst({
          where: { id: rawFocusNodeId, userId },
          select: { id: true, question: true },
        })
      : Promise.resolve(null),
  ])

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
        questions: { canPropose: true, nodes: questionNodes },
        rag: retrieval,
        branch: {
          alias: target.alias,
          topic: target.topic,
          isRoot: branch.path.length === 1,
          summaries: context.summaries,
          existingChildAliases,
          canPropose,
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

  // Se descartan propuestas repetidas (entre sí o con ramas que ya existen) y las que excedan los topes.
  const taken = new Set(existingChildAliases.map(normalizeAlias))
  const proposed = result.response.actions
  const branchActions = canPropose
    ? proposed
        .filter((a) => a.type === 'propose_history_branch')
        .filter((a) => {
          const key = normalizeAlias(a.alias)
          if (taken.has(key)) return false
          taken.add(key)
          return true
        })
        .slice(0, MAX_PROPOSALS_PER_MESSAGE)
    : []
  // Los nodos del mapa de dudas solo pueden colgar de nodos del propio usuario; el resto se descarta.
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
  const questionActions = proposed.filter(
    (a) =>
      a.type === 'propose_question_node' &&
      (a.parent_node_id === null || ownedParents.has(a.parent_node_id)),
  )
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

  const actions = [
    ...branchActions,
    ...questionActions,
    ...fabricApplied.proposals,
    ...toolProposals.valid,
  ]
  const droppedActions =
    result.metadata.droppedActions + (proposed.length - actions.length) + toolProposals.dropped
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
