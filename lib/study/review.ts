/**
 * Repaso de dudas de la materia: resume DÓNDE preguntó más el estudiante para que el agente le
 * recomiende en qué profundizar. Módulo PURO (detección de pedido + armado del texto del prompt):
 * la lectura de la base vive en `lib/study/server.ts`.
 *
 * Es una señal aproximada (cantidad de preguntas, aclaraciones, profundidad de las dudas), no una
 * nota ni una evaluación de lo que la persona sabe.
 */

import { SIGNAL_WEIGHTS } from '@/lib/study/config'
import { normalizeText } from '@/lib/study/signals'

const REVIEW_PATTERNS: RegExp[] = [
  /\b(donde|en que|que (temas?|cosas|partes|conceptos))\b.*\b(mas (preguntas|dudas|consultas)|mas pregunte|mas dudas tuve|mas dificultad|mas me cuesta|me costo|me cuesta)\b/,
  /\b(en que|que)\b.*\b(debo|deberia|tengo que|conviene|me recomendas|recomendame)\b.*\b(profundizar|repasar|reforzar|estudiar mas|practicar)\b/,
  /\b(evalu(a|ar|ame)|analiz(a|ar|ame)|revis(a|ar|ame)|resum(i|ir|ime))\b.*\b(mis |las |todas las )?(preguntas|dudas|consultas|sesiones|conversaciones|historial)\b/,
  /\b(profundizar|reforzar)\b.*\b(segun|de acuerdo|a partir)\b.*\b(preguntas|dudas|historial)\b/,
  /\b(mis puntos debiles|mis debilidades|donde estoy flojo|donde flojeo)\b/,
]

export function wantsStudyReview(text: string): boolean {
  const normalized = normalizeText(text).replace(/[¿?¡!]/g, ' ')
  return REVIEW_PATTERNS.some((pattern) => pattern.test(normalized))
}

export type ReviewSession = {
  title: string
  studentMessages: number
  /** Títulos de los nodos del historial de esa sesión. */
  questions: string[]
  clarifications: number
  struggles: number
  reviewRequests: number
  /** Nivel más profundo alcanzado en el árbol de dudas de la sesión (0 = solo raíz). */
  maxDepth: number
}

export type ReviewData = {
  sessions: ReviewSession[]
  /** Temas de la Carpeta que más atención pidieron, ya ordenados. */
  themes: { title: string; reasons: string[] }[]
  /** Frases textuales del estudiante que pidieron aclaración o marcaron dificultad. */
  quotes: { session: string; text: string }[]
}

const MAX_SESSIONS_SHOWN = 8
const MAX_QUESTIONS_PER_SESSION = 10
const MAX_QUOTES = 6

export function sessionWeight(session: ReviewSession): number {
  return (
    session.studentMessages * SIGNAL_WEIGHTS.question +
    session.clarifications * SIGNAL_WEIGHTS.clarification +
    session.struggles * SIGNAL_WEIGHTS.exerciseStruggle +
    session.reviewRequests * SIGNAL_WEIGHTS.reviewRequest +
    session.maxDepth * SIGNAL_WEIGHTS.depth
  )
}

function describeSession(session: ReviewSession): string {
  const parts = [`${session.studentMessages} pregunta(s) del estudiante`]
  if (session.clarifications) parts.push(`${session.clarifications} pedido(s) de aclaración`)
  if (session.struggles) parts.push(`${session.struggles} dificultad(es) en ejercicios`)
  if (session.reviewRequests) parts.push(`${session.reviewRequests} pedido(s) de repaso`)
  if (session.maxDepth > 0) parts.push(`dudas encadenadas hasta el nivel ${session.maxDepth + 1}`)
  const questions = session.questions.slice(0, MAX_QUESTIONS_PER_SESSION)
  const topics = questions.length ? ` Temas que aparecen: ${questions.map((q) => `«${q}»`).join(', ')}.` : ''
  return `«${session.title}»: ${parts.join(', ')}.${topics}`
}

/** Bloque del prompt con los datos reales de TODAS las sesiones de la materia. */
export function buildStudyReviewPrompt(data: ReviewData): string {
  const lines = [
    'El estudiante te pide evaluar en qué temas tuvo más preguntas para saber en qué profundizar. Respondé con los datos de abajo, que salen de TODAS sus sesiones de esta materia (no solo de esta conversación):',
  ]
  const ranked = [...data.sessions].sort((a, b) => sessionWeight(b) - sessionWeight(a))
  if (ranked.length === 0 || ranked.every((s) => s.studentMessages === 0)) {
    lines.push(
      'Todavía no hay preguntas suficientes en esta materia. Decíselo con claridad, sin inventar temas, e invitalo a seguir estudiando para poder dar una recomendación fundada.',
    )
    return lines.join('\n')
  }
  lines.push(
    `Sesiones ordenadas de más a menos atención pedida (preguntas, aclaraciones, dificultades y profundidad de las dudas):\n${ranked
      .slice(0, MAX_SESSIONS_SHOWN)
      .map((s, i) => `${i + 1}. ${describeSession(s)}`)
      .join('\n')}`,
  )
  if (data.themes.length) {
    lines.push(
      `Temas de la Carpeta que más atención pidieron:\n${data.themes
        .map((t) => `- ${t.title}${t.reasons.length ? ` (${t.reasons.join(', ')})` : ''}`)
        .join('\n')}`,
    )
  }
  if (data.quotes.length) {
    lines.push(
      `Frases del estudiante que pidieron aclaración o marcaron dificultad:\n${data.quotes
        .slice(0, MAX_QUOTES)
        .map((q) => `- (${q.session}) «${q.text}»`)
        .join('\n')}`,
    )
  }
  lines.push(
    'Cómo responder: 1) nombrá los 2 o 3 temas donde más preguntó, con la evidencia concreta (cuántas preguntas, qué pidió aclarar); 2) recomendale en qué profundizar y cómo (por ejemplo, un ejercicio guiado o repasar la definición); 3) aclará que es una señal aproximada basada en cuánto preguntó, no una nota ni una medida de lo que sabe. Usá solo los temas y números de arriba; no inventes. Para este mensaje incluí un único nodo del historial titulado «Repaso de dudas».',
  )
  return lines.join('\n')
}
