import 'server-only'
import { readableOrganizationIds, readScope } from '@/lib/authz'
import { db } from '@/lib/db'
import { getRagConfig } from './config'
import { embedQuery, EmbeddingError, toVectorLiteral } from './embed'
import type { RagSource, RetrievalScopeKind, RetrievalStatus } from './types'
import { getVectorStatus } from './vector'

export type RetrievalResult = {
  status: RetrievalStatus
  scope: RetrievalScopeKind
  workspaceName: string | null
  scopeFileNames: string[]
  sources: RagSource[]
  unindexedFiles: number
  note?: string
}

type ScopeFile = { id: string; name: string; indexStatus: string }

const MENTION_CANDIDATE_LIMIT = 300

function normalize(text: string) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

/**
 * Un archivo se considera pedido por nombre solo si el mensaje contiene el nombre completo con
 * extensión, o el nombre sin extensión entre comillas. Con el nombre suelto habría falsos
 * positivos ("teoria.pdf" no debe activarse porque alguien escribe "la teoría de límites").
 */
function findMentionedFiles<T extends { name: string }>(query: string, files: T[]) {
  const text = normalize(query)
  return files.filter((file) => {
    const full = normalize(file.name)
    if (text.includes(full)) return true
    const base = full.replace(/\.[a-z0-9]{1,5}$/, '')
    if (base.length < 3) return false
    return [`"${base}"`, `'${base}'`, `«${base}»`, `“${base}”`, `\`${base}\``].some((quoted) => text.includes(quoted))
  })
}

type ChunkRow = { fileId: string; fileName: string; pageNumber: number; content: string; score: number }

const MAX_EXERCISE_REFS = 3
const CHUNKS_PER_EXERCISE = 4

/** Números de ejercicio pedidos en el mensaje: "ej 1", "ejercicio 12", "ej. n°3". */
function findExerciseNumbers(query: string) {
  const text = normalize(query)
  const numbers = new Set<number>()
  for (const match of text.matchAll(/\bej(?:ercicios?|s)?\b\.?\s*(?:n[°º.]*\s*)?(\d{1,3})\b/g)) {
    numbers.add(Number.parseInt(match[1], 10))
    if (numbers.size >= MAX_EXERCISE_REFS) break
  }
  return [...numbers]
}

/**
 * Busca los fragmentos más cercanos a la pregunta dentro del alcance permitido.
 *
 * Alcance, por prioridad:
 *   1. archivos elegidos a mano en el chat ('selected')
 *   2. archivos nombrados en el mensaje ('mention')
 *   3. el workspace de la conversación ('workspace'); nunca mezcla materias
 *
 * Los permisos se aplican dos veces: al decidir qué archivos entran (readScope) y de nuevo en la
 * consulta vectorial sobre la fila del archivo. Nunca lanza: los problemas se devuelven en `status`.
 */
export async function retrieveContext({
  userId,
  subjectId,
  query,
  selectedFileIds,
}: {
  userId: string
  subjectId: string | null
  query: string
  selectedFileIds: string[]
}): Promise<RetrievalResult> {
  const empty = (
    status: RetrievalStatus,
    base: Pick<RetrievalResult, 'scope' | 'workspaceName' | 'scopeFileNames'>,
    extra: Partial<RetrievalResult> = {},
  ): RetrievalResult => ({ status, sources: [], unindexedFiles: 0, ...base, ...extra })

  const workspaceName = subjectId
    ? ((
        await db.subject.findFirst({
          where: { AND: [await readScope(userId), { id: subjectId }] },
          select: { name: true },
        })
      )?.name ?? null)
    : 'General'

  try {
    const readable = await readScope(userId)
    let scope: RetrievalScopeKind = 'workspace'
    let files: ScopeFile[]

    if (selectedFileIds.length > 0) {
      scope = 'selected'
      files = await db.file.findMany({
        where: { AND: [readable, { id: { in: selectedFileIds } }, { status: 'ready' }] },
        select: { id: true, name: true, indexStatus: true },
      })
    } else {
      const candidates = await db.file.findMany({
        where: { AND: [readable, { status: 'ready' }] },
        select: { id: true, name: true, indexStatus: true, subjectId: true },
        orderBy: { createdAt: 'desc' },
        take: MENTION_CANDIDATE_LIMIT,
      })
      const mentioned = findMentionedFiles(query, candidates)
      if (mentioned.length > 0) {
        scope = 'mention'
        files = mentioned
      } else {
        files = candidates.filter((file) => file.subjectId === subjectId)
      }
    }

    const base = { scope, workspaceName, scopeFileNames: scope === 'workspace' ? [] : files.map((f) => f.name) }
    const indexed = files.filter((file) => file.indexStatus === 'indexed')
    const unindexedFiles = files.length - indexed.length

    if (indexed.length === 0) {
      return empty('no_sources', base, {
        unindexedFiles,
        note:
          files.length === 0
            ? scope === 'selected'
              ? 'No encontramos los archivos elegidos o no tenés acceso a ellos.'
              : undefined
            : 'Los archivos del alcance todavía no están indexados.',
      })
    }

    const vector = await getVectorStatus()
    if (!vector.ready) return empty('unavailable', base, { unindexedFiles, note: vector.message })

    const { topK, minScore } = getRagConfig()
    const literal = toVectorLiteral(await embedQuery(query))
    const organizationIds = await readableOrganizationIds(userId)
    const fileIds = indexed.map((file) => file.id)

    const rows = await db.$queryRaw<ChunkRow[]>`
      SELECT c."fileId" AS "fileId", f."name" AS "fileName", c."pageNumber" AS "pageNumber",
             c."content" AS "content", (1 - (c."embedding" <=> ${literal}::vector))::float8 AS "score"
      FROM "file_chunks" c
      JOIN "files" f ON f."id" = c."fileId"
      WHERE c."fileId" = ANY(${fileIds}::uuid[])
        AND f."status" = 'ready'
        AND f."indexStatus" = 'indexed'
        AND (
          f."userId" = ${userId}
          OR (f."visibility" = 'organization' AND f."organizationId" = ANY(${organizationIds}::uuid[]))
        )
      ORDER BY c."embedding" <=> ${literal}::vector
      LIMIT ${topK}
    `

    // Un enunciado suele quedar partido entre dos fragmentos (texto y código): se trae el que
    // abre "Ejercicio N" y el siguiente, porque la similitud semántica no distingue "ej 1" de "ej 2".
    const exerciseRows: ChunkRow[] = []
    for (const exercise of findExerciseNumbers(query)) {
      const pattern = `(^|[^0-9a-zA-Z])ejercicio\\s*${exercise}([^0-9]|$)`
      const found = await db.$queryRaw<ChunkRow[]>`
        WITH ordered AS (
          SELECT c."fileId", c."pageNumber", c."content",
                 row_number() OVER (PARTITION BY c."fileId" ORDER BY c."pageNumber", c."chunkIndex") AS rn
          FROM "file_chunks" c
          WHERE c."fileId" = ANY(${fileIds}::uuid[])
        ), hits AS (
          SELECT "fileId", rn FROM ordered WHERE "content" ~* ${pattern} ORDER BY "fileId", rn LIMIT ${CHUNKS_PER_EXERCISE}
        )
        SELECT DISTINCT o."fileId" AS "fileId", f."name" AS "fileName", o."pageNumber" AS "pageNumber",
               o."content" AS "content", 1::float8 AS "score", o.rn AS "rn"
        FROM ordered o
        JOIN hits h ON h."fileId" = o."fileId" AND o.rn BETWEEN h.rn AND h.rn + 1
        JOIN "files" f ON f."id" = o."fileId"
        WHERE f."status" = 'ready'
          AND f."indexStatus" = 'indexed'
          AND (
            f."userId" = ${userId}
            OR (f."visibility" = 'organization' AND f."organizationId" = ANY(${organizationIds}::uuid[]))
          )
        ORDER BY o."fileId", o.rn
      `
      exerciseRows.push(...found)
    }

    const seen = new Set<string>()
    const merged = [...exerciseRows, ...rows.filter((row) => row.score >= minScore)].filter((row) => {
      const key = `${row.fileId}:${row.pageNumber}:${row.content}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    const sources: RagSource[] = merged
      .map((row, index) => ({
        ref: index + 1,
        fileId: row.fileId,
        fileName: row.fileName,
        pageNumber: row.pageNumber,
        text: row.content,
        score: Math.round(row.score * 1000) / 1000,
        cited: false,
      }))

    return { status: sources.length > 0 ? 'ok' : 'no_match', sources, unindexedFiles, ...base }
  } catch (error) {
    if (!(error instanceof EmbeddingError)) console.error('[rag] retrieval failed', error)
    return empty(
      'unavailable',
      { scope: 'workspace', workspaceName, scopeFileNames: [] },
      {
        note:
          error instanceof EmbeddingError
            ? error.message
            : 'No se pudo buscar en tus documentos. Probá de nuevo en unos minutos.',
      },
    )
  }
}
