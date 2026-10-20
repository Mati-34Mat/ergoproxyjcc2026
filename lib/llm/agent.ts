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
  /** Ramas que se separaron de este camino, en una línea cada una (ver `otherBranches`). */
  otherBranches: LabeledText[]
  truncated: boolean
}

export type QuestionMapPromptInfo = {
  canPropose: boolean
  nodes: { id: string; question: string }[]
  /** Último nodo del historial que salió de esta rama: el padre natural de la próxima duda. */
  currentId: string | null
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
  if (branch.otherBranches.length) {
    lines.push(
      'Otras ramas que se separaron de este camino. Solo sabés de qué tratan: podés mencionarlas o remitir a ellas, pero no asumas sus detalles ni los mezcles con esta rama:',
      ...branch.otherBranches.map((b) => `- «${b.label}»: ${b.text}`),
    )
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
    'Si el estudiante pide guardar o agregar algo a la Carpeta ("agregame esto", "guardalo", "sumalo a la carpeta"), SIEMPRE incluí una acción propose_folder_change con el contenido real y completo de lo explicado antes en content_md (copialo de tu respuesta anterior, no lo resumas). Nunca digas que no podés modificar la Carpeta: la propuesta no se ejecuta sola, el estudiante la confirma. En ese caso avisale en output que le dejaste la propuesta para confirmar.',
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

function buildQuestionMapPrompt(questions: QuestionMapPromptInfo, focusNodeId: string | null) {
  if (!questions.canPropose) return ''
  const lines = [
    'Historial de dudas: es el árbol de preguntas de la materia que el estudiante ve y usa para volver a cualquier tema. Acción: {"type":"propose_question_node","parent_node_id":<id de la lista o null>,"title":<alias de 2 a 6 palabras>,"description":<qué se resolvió, en una oración>}.',
    '- El nodo representa la duda que el estudiante ACABA de hacer y que esta respuesta resolvió; nunca un tema que podría venir después. Incluí UN nodo en TODAS tus respuestas, incluso saludos, agradecimientos y repreguntas: se agrega solo al historial, sin que el estudiante lo confirme. Excepción: si el mensaje trae dos o tres dudas claramente distintas (temas que se podrían estudiar por separado), incluí un nodo por cada una, con su propio title, description y parent_node_id, y respondé a todas; así el historial se bifurca solo. No dividas una duda única en pasos ni inventes dudas que el estudiante no hizo. Si la duda sigue dentro del tema de un nodo existente, colgala de ese nodo con un título propio (el paso, el caso o el matiz que se preguntó) en lugar de repetir el título.',
    '- title: el mismo concepto que pusiste en description (por ejemplo, a «¿Qué es una derivada?�� le corresponde «Definición de derivada», no «Aplicaciones de la derivada»). Nunca copies la pregunta.',
    '- parent_node_id, en este orden: 1) si el estudiante eligió un nodo para continuar, ese; 2) si la duda profundiza o sigue la conversación reciente, el nodo marcado (actual); 3) si no, el nodo existente más general del que es un subtema (puede ser de otra sesión), prefiriendo el concepto antes que un ejemplo; 4) null solo si el historial está vacío o la duda no tiene relación alguna con la conversación; ante la duda, colgala del nodo (actual). Cuando un mensaje trae varias dudas, todas cuelgan del mismo padre salvo que una sea claramente subtema de otra.',
  ]
  if (questions.nodes.length) {
    const marker = (id: string) =>
      id === focusNodeId ? ' (el estudiante continúa desde acá)' : id === questions.currentId ? ' (actual)' : ''
    lines.push(
      `Nodos existentes del historial de dudas:\n${questions.nodes.map((n) => `- ${n.id}: ${n.question}${marker(n.id)}`).join('\n')}`,
    )
  } else {
    lines.push('El historial de dudas está vacío: el primer nodo va con parent_node_id null.')
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
    `Herramientas disponibles (solo como propuestas; nunca se ejecutan solas): ${TOOL_LABELS.propose_diagram}, ${TOOL_LABELS.generate_file}. Además, la ${TOOL_LABELS.propose_folder_change} y los nodos del historial de dudas.`,
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
    '- actions: lista de acciones PROPUESTAS; el estudiante decide si las acepta. Incluí solo las que aporten (criterios abajo para cada una).',
    buildQuestionMapPrompt(questions, focusNode?.id ?? null),
    buildFolderPrompt(folder),
    buildToolsPrompt(tools),
    buildBranchPrompt(branch),
    rag ? buildRagPrompt(rag) : '',
    focusNode
      ? `El estudiante volvió al nodo ${focusNode.id} («${focusNode.question}») del historial de dudas y sigue preguntando desde ahí. Si la nueva duda es un subtema de ese nodo, usalo como parent_node_id.`
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
    const { valid, dropped, issues } = validateActions(actions)
    if (issues.length) console.error('[llm] Acciones descartadas:', issues.join(' || '))
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
