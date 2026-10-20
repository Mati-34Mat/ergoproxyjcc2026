import 'server-only'
import { z } from 'zod'
import { readScope } from '@/lib/authz'
import { getSubjectsRepo } from '@/lib/data/subjects-repo'
import { db } from '@/lib/db'
import { isDatabaseConfigured } from '@/lib/db/config'

// Toda consulta recibe `userId` y lo aplica en el WHERE (ver lib/authz.ts): no hay RLS en Neon.
// Subject, File y Document usan `readScope` (propios + compartidos por la organización);
// conversaciones, mensajes y dudas son siempre privados del dueño.

const uuid = z.uuid()
export const isUuid = (value: string) => uuid.safeParse(value).success

export async function getOverview(userId: string) {
  if (!isDatabaseConfigured) {
    return { subjects: 0, files: 0, conversations: 0, documents: 0, openQuestions: 0 }
  }
  const scope = await readScope(userId)
  const [subjects, files, conversations, documents, openQuestions] = await Promise.all([
    db.subject.count({ where: scope }),
    db.file.count({ where: scope }),
    db.conversation.count({ where: { userId } }),
    db.document.count({ where: scope }),
    db.questionNode.count({ where: { userId, status: 'open' } }),
  ])
  return { subjects, files, conversations, documents, openQuestions }
}

export async function listSubjects(userId: string) {
  return getSubjectsRepo().list(userId)
}

/** Resumen del workspace fijo General: lo que todavía no pertenece a ninguna materia. */
export async function getGeneralSummary(userId: string) {
  if (!isDatabaseConfigured) {
    return { fileCount: 0, documentCount: 0, conversationCount: 0, lastActivityAt: null }
  }
  const scope = await readScope(userId)
  const [f, d, c] = await Promise.all([
    db.file.aggregate({
      where: { AND: [scope, { subjectId: null }] },
      _count: { _all: true },
      _max: { createdAt: true },
    }),
    db.document.aggregate({
      where: { AND: [scope, { subjectId: null }] },
      _count: { _all: true },
      _max: { updatedAt: true },
    }),
    db.conversation.aggregate({
      where: { userId, subjectId: null },
      _count: { _all: true },
      _max: { updatedAt: true },
    }),
  ])
  const dates = [f._max.createdAt, d._max.updatedAt, c._max.updatedAt].filter(
    (v): v is Date => v instanceof Date,
  )
  return {
    fileCount: f._count._all,
    documentCount: d._count._all,
    conversationCount: c._count._all,
    lastActivityAt: dates.length ? new Date(Math.max(...dates.map((x) => x.getTime()))) : null,
  }
}

export async function listGeneralFiles(userId: string) {
  if (!isDatabaseConfigured) return []
  const scope = await readScope(userId)
  return db.file.findMany({
    where: { AND: [scope, { subjectId: null }] },
    orderBy: { createdAt: 'desc' },
  })
}

export async function listGeneralDocuments(userId: string) {
  if (!isDatabaseConfigured) return []
  const scope = await readScope(userId)
  return db.document.findMany({
    where: { AND: [scope, { subjectId: null }] },
    select: { id: true, title: true, kind: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
  })
}

/** Búsqueda por nombre/título en todo lo que la persona puede ver. */
export async function searchAll(userId: string, query: string) {
  const term = query.trim()
  if (!term) return { subjects: [], files: [], documents: [], conversations: [] }

  const matchingSubjects = (await getSubjectsRepo().list(userId)).filter(
    (s) =>
      s.name.toLowerCase().includes(term.toLowerCase()) ||
      (s.code ?? '').toLowerCase().includes(term.toLowerCase()),
  )
  if (!isDatabaseConfigured) {
    return { subjects: matchingSubjects, files: [], documents: [], conversations: [] }
  }

  const scope = await readScope(userId)
  const contains = { contains: term, mode: 'insensitive' } as const
  const [files, documents, conversations] = await Promise.all([
    db.file.findMany({
      where: { AND: [scope, { name: contains }] },
      select: { id: true, name: true, subjectId: true },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
    db.document.findMany({
      where: { AND: [scope, { title: contains }] },
      select: { id: true, title: true },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    }),
    db.conversation.findMany({
      where: { userId, title: contains },
      select: { id: true, title: true },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    }),
  ])
  return { subjects: matchingSubjects, files, documents, conversations }
}

export async function listSubjectOptions(userId: string) {
  if (!isDatabaseConfigured) {
    return (await getSubjectsRepo().list(userId)).map(({ id, name }) => ({ id, name }))
  }
  const scope = await readScope(userId)
  return db.subject.findMany({
    where: scope,
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })
}

export async function getSubject(userId: string, id: string) {
  return getSubjectsRepo().get(userId, id)
}

export async function listFiles(userId: string, subjectId?: string) {
  if (!isDatabaseConfigured) return []
  if (subjectId && !isUuid(subjectId)) return []
  const scope = await readScope(userId)
  const rows = await db.file.findMany({
    where: { AND: [scope, subjectId ? { subjectId } : {}] },
    include: { subject: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  })
  return rows.map(({ subject, ...file }) => ({ ...file, subjectName: subject?.name ?? null }))
}

/** Archivos que el chat puede consultar: legibles por la persona y ya indexados. */
export async function listChatFiles(userId: string) {
  if (!isDatabaseConfigured) return []
  const scope = await readScope(userId)
  const rows = await db.file.findMany({
    where: { AND: [scope, { status: 'ready', indexStatus: 'indexed' }] },
    select: { id: true, name: true, subject: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  return rows.map((f) => ({ id: f.id, name: f.name, subjectName: f.subject?.name ?? null }))
}

export async function listDocuments(userId: string, subjectId?: string) {
  if (!isDatabaseConfigured) return []
  const scope = await readScope(userId)
  const rows = await db.document.findMany({
    where: { AND: [scope, subjectId ? { subjectId } : {}] },
    select: {
      id: true,
      title: true,
      kind: true,
      subjectId: true,
      updatedAt: true,
      subject: { select: { name: true } },
    },
    orderBy: { updatedAt: 'desc' },
  })
  return rows.map(({ subject, ...doc }) => ({ ...doc, subjectName: subject?.name ?? null }))
}

export async function getDocument(userId: string, id: string) {
  if (!isDatabaseConfigured) return undefined
  if (!isUuid(id)) return undefined
  const scope = await readScope(userId)
  const row = await db.document.findFirst({
    where: { AND: [scope, { id }] },
    include: { subject: { select: { name: true } } },
  })
  if (!row) return undefined
  const { subject, ...doc } = row
  return { ...doc, subjectName: subject?.name ?? null }
}

export async function listConversations(userId: string, subjectId?: string) {
  if (!isDatabaseConfigured) return []
  const rows = await db.conversation.findMany({
    where: { userId, ...(subjectId ? { subjectId } : {}) },
    include: {
      subject: { select: { name: true } },
      _count: { select: { messages: true } },
    },
    orderBy: { updatedAt: 'desc' },
  })
  return rows.map(({ subject, _count, ...conversation }) => ({
    ...conversation,
    subjectName: subject?.name ?? null,
    messageCount: _count.messages,
  }))
}

export async function getConversationWithMessages(userId: string, id: string) {
  if (!isDatabaseConfigured) return undefined
  if (!isUuid(id)) return undefined
  const row = await db.conversation.findFirst({
    where: { id, userId },
    include: { subject: { select: { name: true } } },
  })
  if (!row) return undefined
  const { subject, ...rest } = row

  const messages = await db.message.findMany({
    where: { conversationId: id, userId },
    include: {
      agentActions: { orderBy: { createdAt: 'asc' } },
    },
    orderBy: { createdAt: 'asc' },
  })

  return {
    conversation: { ...rest, subjectName: subject?.name ?? null },
    messages,
  }
}

/** Datos de la conversación sin mensajes: los mensajes dependen de la rama que se muestre. */
export async function getConversationHeader(userId: string, id: string) {
  if (!isUuid(id)) return undefined
  const row = await db.conversation.findFirst({
    where: { id, userId },
    include: { subject: { select: { name: true } } },
  })
  if (!row) return undefined
  const { subject, ...rest } = row
  return { ...rest, subjectName: subject?.name ?? null }
}

export async function listQuestionNodes(userId: string, subjectId?: string) {
  if (!isDatabaseConfigured) return []
  return db.questionNode.findMany({
    where: { userId, ...(subjectId ? { subjectId } : {}) },
    orderBy: { createdAt: 'asc' },
  })
}

/** Historial de dudas de una sola conversación: cada sesión tiene su propio árbol. */
export async function listConversationQuestionNodes(userId: string, conversationId: string | null) {
  if (!isDatabaseConfigured || !conversationId || !isUuid(conversationId)) return []
  return db.questionNode.findMany({
    where: { userId, conversationId },
    orderBy: { createdAt: 'asc' },
  })
}

/**
 * Grafo completo de la Carpeta de una materia: apuntes, relaciones y de dónde
 * salió cada nota. Es independiente del mapa de dudas.
 */
export async function getFolderGraph(userId: string, subjectId: string) {
  if (!isDatabaseConfigured || !isUuid(subjectId)) return { nodes: [], edges: [] }

  const [nodes, edges] = await Promise.all([
    db.folderNode.findMany({
      where: { userId, subjectId },
      include: {
        sources: {
          select: {
            id: true,
            label: true,
            conversationId: true,
            messageId: true,
            questionNodeId: true,
            conversation: { select: { title: true } },
            questionNode: { select: { question: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: { createdAt: 'asc' },
    }),
    db.folderEdge.findMany({
      where: { userId, from: { subjectId } },
      select: { id: true, fromId: true, toId: true, kind: true },
    }),
  ])

  return { nodes, edges }
}

/** Busca apuntes por título y por contenido, dentro de una materia. */
export async function searchFolderNodes(userId: string, subjectId: string, query: string) {
  if (!isDatabaseConfigured || !isUuid(subjectId)) return []
  const term = query.trim()
  if (!term) return []

  const contains = { contains: term, mode: 'insensitive' } as const
  return db.folderNode.findMany({
    where: {
      userId,
      subjectId,
      OR: [{ title: contains }, { contentMd: contains }],
    },
    select: { id: true, title: true, type: true },
    orderBy: { updatedAt: 'desc' },
    take: 20,
  })
}

export type SubjectWithCounts = Awaited<ReturnType<typeof listSubjects>>[number]
export type FileRow = Awaited<ReturnType<typeof listFiles>>[number]
export type DocumentRow = Awaited<ReturnType<typeof listDocuments>>[number]
export type ConversationRow = Awaited<
  ReturnType<typeof listConversations>
>[number]
