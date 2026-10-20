import 'server-only'

import { APICallError, generateText, NoObjectGeneratedError, Output, RetryError, type LanguageModel } from 'ai'
import { getLlmFallback, getLlmRetryModel, getLlmServerConfig } from '@/lib/llm/config'
import {
  agentResponseSchema,
  MODE_LABELS,
  type AgentResponse,
  type ConversationMode,
  type MessageMetadata,
} from '@/lib/llm/contract'
import { recover, validateActions } from '@/lib/llm/recover'
import { buildRagPrompt } from '@/lib/rag/prompt'
import type { RetrievalResult } from '@/lib/rag/retrieve'
import type { LabeledText } from '@/lib/tree/compose'
import {
  FOLDER_EDGE_LABELS,
  FOLDER_NODE_LABELS,
  MAX_FOLDER_PROPOSALS_PER_MESSAGE,
  PROMPT_INDEX_LIMIT,
  TITLE_MAX,
} from '@/lib/folder/config'
import { FOLDER_OPERATIONS, FOLDER_OPERATION_LABELS } from '@/lib/folder/schema'
import { ALIAS_MAX, MAX_PROPOSALS_PER_MESSAGE } from '@/lib/tree/config'
import {
  GENERATED_FILE_FORMATS,
  GENERATED_FILE_NAME_MAX,
  MERMAID_DIAGRAM_TYPES,
  TOOL_LABELS,
} from '@/lib/tools/config'
import { buildWebPrompt } from '@/lib/tools/prompt'
import type { WebSearchOutcome } from '@/lib/tools/web-search'

export type FolderPromptInfo = {
  canPropose: boolean
  nodes: { id: string; title: string; type: string }[]
  /**
   * Temas de la Carpeta que más atención pidieron (preguntas, repeticiones,
   * aclaraciones…), ya ordenados. Es una pista para PRIORIZAR dónde escribir más,
   * no una orden ni una evaluación del estudiante.
   */
  priorities?: { nodeId: string; title: string; reasons: string[] }[]
}

export type BranchPromptInfo = {
  alias: string
  topic: string
  isRoot: boolean
  summaries: LabeledText[]
  existingChildAliases: string[]
  /** false cuando ya se alcanzó el tope de ramas o de profundidad. */
  canPropose: boolean
  truncated: boolean
}

export type QuestionMapPromptInfo = {
  canPropose: boolean
  nodes: { id: string; question: string }[]
}

export type AgentResult = { response: AgentResponse; metadata: MessageMetadata }

/**
 * Contexto de las herramientas para el prompt. Las de lectura (web) ya se ejecutaron
 * en el servidor; las de escritura/propuesta se explican para que el modelo las use
 * como PROPUESTAS (nunca se ejecutan solas).
 */
export type ToolsPromptInfo = {
  /** Resultado real de la búsqueda web, si el usuario la pidió y hay proveedor. */
  web?: WebSearchOutcome
  /** ¿El usuario pidió generar un archivo descargable? */
  wantsFile?: boolean
  /** ¿El usuario pidió un diagrama? */
  wantsDiagram?: boolean
}

const MODE_GUIDANCE: Record<ConversationMode, string> = {
  theory:
    'Modo Teoría: explicá conceptos, definiciones y demostraciones con rigor, y enlazá las ideas entre sí.',
  practice:
    'Modo Práctica: guiá la resolución de ejercicios paso a paso, pedí que el estudiante intente y corregí sin dar todo resuelto de entrada.',
  free: 'Modo Libre: respondé de forma flexible según lo que pregunte el estudiante.',
}

function buildBranchPrompt(branch: BranchPromptInfo) {
  const lines = [
    `Esta conversación es un árbol de ramas independientes. Estás en la rama «${branch.alias}»${
      branch.isRoot ? ' (la inicial)' : ` (tema: ${branch.topic})`
    }. Solo conocés esta rama y lo que heredó de sus ancestros hasta el punto de bifurcación; no sabés qué se habló en otras ramas.`,
  ]
  if (branch.summaries.length) {
    lines.push(
      'Contexto resumido de la rama (reemplaza a los mensajes más antiguos; tomalo como cierto):',
      ...branch.summaries.map((s) => `### ${s.label}\n${s.text}`),
    )
  }
  if (branch.truncated) {
    lines.push('Parte del historial más antiguo no está disponible; no asumas lo que no figure arriba.')
  }
  if (branch.existingChildAliases.length) {
    lines.push(`Ramas que ya salen de esta: ${branch.existingChildAliases.map((a) => `«${a}»`).join(', ')}. No las repitas.`)
  }
  return lines.join('\n')
}

function buildFolderPrompt(folder: FolderPromptInfo) {
  if (!folder.canPropose) {
    return 'La Carpeta del estudiante está llena: no propongas acciones de tipo propose_folder_change.'
  }
  const priorities = folder.priorities ?? []
  // Los temas prioritarios tienen que estar sí o sí en la lista: el agente solo
  // puede usar ids que figuren ahí. Se muestran primero, sin duplicar.
  const priorityIds = new Set(priorities.map((p) => p.nodeId))
  const shown = [
    ...folder.nodes.filter((n) => priorityIds.has(n.id)),
    ...folder.nodes.filter((n) => !priorityIds.has(n.id)),
  ].slice(0, PROMPT_INDEX_LIMIT)
  const shownIds = new Set(shown.map((n) => n.id))
  const visiblePriorities = priorities.filter((p) => shownIds.has(p.nodeId))
  const kinds = Object.entries(FOLDER_NODE_LABELS)
    .map(([type, label]) => `${type} (${label})`)
    .join(', ')
  const edgeKinds = Object.entries(FOLDER_EDGE_LABELS)
    .map(([kind, label]) => `${kind} (${label})`)
    .join(', ')
  const operations = FOLDER_OPERATIONS.map((op) => `${op} (${FOLDER_OPERATION_LABELS[op]})`).join(', ')
  const lines = [
    `La Carpeta es el cuaderno ordenado del estudiante, separado de este chat. Acción disponible: {"type":"propose_folder_change","operation":<${operations}>,"target_node_id":<id>|null,"related_node_id":<id>|null,"edge_kind":<${edgeKinds}>|null,"node_type":<${kinds}>|null,"title":<hasta ${TITLE_MAX} caracteres>|null,"content_md":<Markdown>|null,"solution_md":<Markdown>|null,"reason":<por qué conviene guardarlo>}.`,
    `Usala SOLO cuando lo explicado tiene valor para estudiar después (una definición, los puntos clave de un tema, un ejercicio con su resolución) o cuando el estudiante pide guardarlo. Máximo ${MAX_FOLDER_PROPOSALS_PER_MESSAGE} por respuesta; la mayoría de las respuestas no necesitan ninguna.`,
    '- create_node: apunte nuevo (title y content_md obligatorios; node_type opcional). En target_node_id podés poner el apunte que lo contiene, o null.',
    '- append_content: agrega contenido a un apunte que YA existe (target_node_id y content_md). Preferilo sobre create_node cuando el tema ya está en la lista.',
    '- replace_content: reescribe el apunte entero (target_node_id y content_md). Usalo solo si el contenido viejo quedó mal, nunca para agregar.',
    '- relate_nodes: relaciona dos apuntes existentes (target_node_id y related_node_id, más edge_kind: "contains" si el primero contiene al segundo, "relates" si solo se vinculan, "solves" si una resolución resuelve un ejercicio).',
    '- create_exercise_with_solution: crea el ejercicio y su resolución juntos (title, content_md = enunciado, solution_md = resolución).',
    'Usá únicamente ids de la lista; nunca inventes ids. Si la lista está vacía, solo podés usar create_node o create_exercise_with_solution.',
  ]
  lines.push(
    shown.length
      ? `Apuntes existentes en la Carpeta:\n${shown.map((n) => `- ${n.id} · ${n.type} · ${n.title}`).join('\n')}`
      : 'La Carpeta todavía no tiene apuntes.',
  )
  if (visiblePriorities.length) {
    lines.push(
      'Temas a los que el estudiante les dedicó MÁS atención (medido por cuántas veces preguntó, volvió sobre el tema o pidió aclaraciones; no es una nota ni una evaluación). Cuando propongas cambios en la Carpeta, PRIORIZÁ estos temas: preferí ampliar el apunte que ya existe (append_content) o crear uno nuevo antes que tocar los demás, y desarrollá su contenido con más detalle.',
      `Temas prioritarios:\n${visiblePriorities
        .map((p) => `- ${p.nodeId} · ${p.title}${p.reasons.length ? ` (${p.reasons.join(', ')})` : ''}`)
        .join('\n')}`,
    )
  }
  return lines.join('\n')
}

function buildQuestionMapPrompt(questions: QuestionMapPromptInfo) {
  if (!questions.canPropose) return ''
  const lines = [
    'También podés proponer un nodo en el mapa de dudas de la materia: {"type":"propose_question_node","parent_node_id":<id de la lista o null>,"title":<alias corto>,"description":<tema específico>}. Usala cuando la respuesta abre un subtema que merece su propio nodo del mapa (distinto de las ramas de ESTA conversación).',
  ]
  if (questions.nodes.length) {
    lines.push(`Nodos existentes del mapa de dudas:\n${questions.nodes.map((n) => `- ${n.id}: ${n.question}`).join('\n')}`)
  }
  return lines.join('\n')
}

/**
 * Herramientas del agente. Las de escritura (Carpeta, rama, archivo) se explican
 * como PROPUESTAS: el modelo las sugiere y la persona confirma. Los diagramas se
 * ofrecen siempre (son útiles para explicar); los archivos, solo si los piden.
 */
function buildToolsPrompt(tools: ToolsPromptInfo | undefined) {
  const lines: string[] = []
  lines.push(
    `Herramientas disponibles (solo como propuestas; nunca se ejecutan solas): ${TOOL_LABELS.propose_diagram}, ${TOOL_LABELS.generate_file}. Además, la ${TOOL_LABELS.propose_folder_change} y las ramas de arriba.`,
  )
  lines.push(
    `- Diagrama: {"type":"propose_diagram","diagram_type":<${MERMAID_DIAGRAM_TYPES.join(' | ')}>,"title":<título>, "source":<código Mermaid válido Y editable>,"reason":<por qué ayuda>}. Proponelo cuando un diagrama aclare la explicación (flujos, relaciones, secuencias). El estudiante lo puede editar y guardar como apunte.`,
  )
  if (tools?.wantsFile) {
    lines.push(
      `- Archivo: el estudiante pidió un archivo descargable. Proponé {"type":"generate_file","format":<${GENERATED_FILE_FORMATS.join(' | ')}>,"file_name":<hasta ${GENERATED_FILE_NAME_MAX} caracteres>,"content":<contenido completo y real del archivo>,"reason":<por qué>}. El contenido debe ser el archivo entero (Markdown, CSV o texto), no un resumen. No digas que el archivo está descargado: se genera cuando el estudiante lo confirme.`,
    )
  } else {
    lines.push(
      '- Si el estudiante pide guardar o exportar algo como archivo, proponé "generate_file" con el contenido completo.',
    )
  }
  const webOutcome = tools?.web
  if (webOutcome) lines.push(buildWebPrompt(webOutcome))
  return lines.join('\n')
}

function buildSystemPrompt(
  mode: ConversationMode,
  branch: BranchPromptInfo,
  folder: FolderPromptInfo,
  questions: QuestionMapPromptInfo,
  rag: RetrievalResult | undefined,
  focusNode: { id: string; question: string } | null,
  tools: ToolsPromptInfo | undefined,
) {
  return [
    'Sos un tutor para estudiantes de ingeniería y ciencias exactas de la FCEIA (UNR). Respondé en español rioplatense, con claridad y paso a paso.',
    MODE_GUIDANCE[mode],
    'Tu respuesta es un objeto JSON con cuatro campos:',
    '- output: el texto visible para el estudiante, en Markdown (podés usar listas, tablas y bloques de código).',
    '- description: alias corto (2 a 5 palabras, máximo 80 caracteres) del concepto o problema específico tratado, por ejemplo «Sustitución en integrales». Nunca copies la pregunta completa.',
    '- grounding: "documents", "mixed", "general" o "insufficient" según cuánto de la respuesta se apoya en los documentos del estudiante (criterios abajo). Sin fragmentos de documentos, usá "general" o "insufficient".',
    '- actions: lista de acciones PROPUESTAS; casi siempre debe estar vacía. Las acciones son propuestas: el estudiante decide si las acepta.',
    branch.canPropose
      ? `Rama del historial de ESTA conversación: {"type":"propose_history_branch","alias":<alias de hasta ${ALIAS_MAX} caracteres>,"description":<tema específico de la rama>}. Proponé ramas solo cuando la respuesta descompone la pregunta en subproblemas claramente distintos que conviene explorar por separado (por ejemplo, la definición que se usa y un paso del cálculo) o cuando el estudiante cambia de tema. Máximo ${MAX_PROPOSALS_PER_MESSAGE} por respuesta, y ninguna que repita lo que ya explicaste.`
      : 'Esta conversación ya no admite más ramas: no propongas acciones propose_history_branch.',
    buildQuestionMapPrompt(questions),
    buildFolderPrompt(folder),
    buildToolsPrompt(tools),
    buildBranchPrompt(branch),
    rag ? buildRagPrompt(rag) : '',
    focusNode
      ? `El estudiante volvió al nodo ${focusNode.id} («${focusNode.question}») del mapa de dudas y sigue preguntando desde ahí.`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export class AgentError extends Error {}

function providerStatus(error: unknown): number | undefined {
  const cause = RetryError.isInstance(error) ? error.lastError : error
  return APICallError.isInstance(cause) ? cause.statusCode : undefined
}

export async function runAgent({
  mode,
  branch,
  folder,
  questions,
  history,
  rag,
  focusNode = null,
  tools,
}: {
  mode: ConversationMode
  branch: BranchPromptInfo
  folder: FolderPromptInfo
  questions: QuestionMapPromptInfo
  history: { role: 'user' | 'assistant'; content: string }[]
  rag?: RetrievalResult
  /** Nodo del mapa de dudas desde el que el estudiante decidió continuar, si eligió uno. */
  focusNode?: { id: string; question: string } | null
  /** Herramientas del turno (búsqueda web ya ejecutada, intención de archivo/diagrama). */
  tools?: ToolsPromptInfo
}): Promise<AgentResult> {
  const config = getLlmServerConfig()
  const system = buildSystemPrompt(mode, branch, folder, questions, rag, focusNode, tools)

  const generate = (model: LanguageModel) =>
    generateText({
      model,
      system,
      messages: history,
      output: Output.object({ schema: agentResponseSchema }),
      timeout: 60_000,
    })

  let { modelId } = config

  try {
    let result
    try {
      result = await generate(config.model)
    } catch (error) {
      const status = providerStatus(error)
      const overloaded = status === 429 || (status !== undefined && status >= 500)
      const fallback = [401, 402, 403].includes(status ?? 0)
        ? getLlmFallback(config.provider)
        : overloaded
          ? getLlmRetryModel(config)
          : null
      if (!fallback) throw error
      console.error(`[llm] ${config.modelId} falló (HTTP ${status}); se reintenta con ${fallback.modelId}.`)
      modelId = fallback.modelId
      result = await generate(fallback.model)
    }
    const { output, description, grounding, actions } = result.output
    // El esquema de generación usa una variante "plana" de las propuestas (sin
    // refinamientos, por límites del proveedor). Acá se revalidan una por una con
    // el contrato estricto: las que no cumplen se descartan y no llegan a guardarse.
    const { valid, dropped } = validateActions(actions)
    return {
      response: { output, description, grounding, actions: valid },
      metadata: { model: modelId, recovery: 'none', droppedActions: dropped },
    }
  } catch (error) {
    const cause = RetryError.isInstance(error) ? error.lastError : error
    console.error(
      '[llm] Falló la generación:',
      cause instanceof Error ? cause.message : cause,
      APICallError.isInstance(cause) ? `(HTTP ${cause.statusCode}) ${cause.responseBody?.slice(0, 500)}` : '',
    )
    if (NoObjectGeneratedError.isInstance(error)) {
      const recovered = recover(error.text)
      if (recovered) {
        return {
          response: recovered.response,
          metadata: { model: modelId, recovery: recovered.kind, droppedActions: recovered.dropped },
        }
      }
      throw new AgentError('El modelo devolvió una respuesta que no pudimos interpretar. Probá de nuevo.')
    }
    throw new AgentError('No pudimos comunicarnos con el modelo de lenguaje. Probá de nuevo en unos minutos.')
  }
}

export { MODE_LABELS }
