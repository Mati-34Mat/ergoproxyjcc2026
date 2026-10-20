import 'server-only'
import { z } from 'zod'
import { readScope, writeScope } from '@/lib/authz'
import { db } from '@/lib/db'
import { isDatabaseConfigured } from '@/lib/db/config'

// Dos adaptadores con la misma interfaz: Postgres (Prisma sobre Neon) y memoria para el modo demo.
// Toda operación recibe `userId` y lo aplica en el WHERE (ver lib/authz.ts): no hay RLS en Neon.

export type SubjectRecord = {
  id: string
  name: string
  code: string | null
  description: string | null
  color: string
  icon: string
  createdAt: Date
  updatedAt: Date
}

export type SubjectSummary = SubjectRecord & {
  fileCount: number
  conversationCount: number
  documentCount: number
  lastActivityAt: Date
}

export type SubjectInput = {
  name: string
  code: string | null
  description: string | null
  color: string
  icon: string
}

export interface SubjectsRepo {
  list(userId: string): Promise<SubjectSummary[]>
  get(userId: string, id: string): Promise<SubjectRecord | undefined>
  create(userId: string, input: SubjectInput): Promise<{ id: string }>
  createMany(userId: string, inputs: SubjectInput[]): Promise<number>
  update(userId: string, id: string, input: SubjectInput): Promise<boolean>
  rename(userId: string, id: string, name: string): Promise<boolean>
  remove(userId: string, id: string): Promise<boolean>
}

const uuid = z.uuid()

// --- Postgres --------------------------------------------------------------

const subjectSelect = {
  id: true,
  name: true,
  code: true,
  description: true,
  color: true,
  icon: true,
  createdAt: true,
  updatedAt: true,
} as const

const latest = (...dates: (Date | null | undefined)[]) =>
  new Date(Math.max(...dates.filter((d): d is Date => d instanceof Date).map((d) => d.getTime())))

const postgresRepo: SubjectsRepo = {
  async list(userId) {
    const scope = await readScope(userId)
    const subjects = await db.subject.findMany({
      where: scope,
      select: subjectSelect,
      orderBy: { name: 'asc' },
    })
    if (subjects.length === 0) return []

    const subjectIds = subjects.map((s) => s.id)
    const [files, conversations, documents] = await Promise.all([
      db.file.groupBy({
        by: ['subjectId'],
        where: { AND: [scope, { subjectId: { in: subjectIds } }] },
        _count: { _all: true },
        _max: { createdAt: true },
      }),
      db.conversation.groupBy({
        by: ['subjectId'],
        where: { userId, subjectId: { in: subjectIds } },
        _count: { _all: true },
        _max: { updatedAt: true },
      }),
      db.document.groupBy({
        by: ['subjectId'],
        where: { AND: [scope, { subjectId: { in: subjectIds } }] },
        _count: { _all: true },
        _max: { updatedAt: true },
      }),
    ])

    const fileBy = new Map(files.map((r) => [r.subjectId, r]))
    const conversationBy = new Map(conversations.map((r) => [r.subjectId, r]))
    const documentBy = new Map(documents.map((r) => [r.subjectId, r]))

    return subjects.map((s) => {
      const f = fileBy.get(s.id)
      const c = conversationBy.get(s.id)
      const d = documentBy.get(s.id)
      return {
        ...s,
        fileCount: f?._count._all ?? 0,
        conversationCount: c?._count._all ?? 0,
        documentCount: d?._count._all ?? 0,
        lastActivityAt: latest(s.updatedAt, f?._max.createdAt, c?._max.updatedAt, d?._max.updatedAt),
      }
    })
  },

  async get(userId, id) {
    if (!uuid.safeParse(id).success) return undefined
    const scope = await readScope(userId)
    const row = await db.subject.findFirst({
      where: { AND: [scope, { id }] },
      select: subjectSelect,
    })
    return row ?? undefined
  },

  async create(userId, input) {
    return db.subject.create({ data: { userId, ...input }, select: { id: true } })
  },

  async createMany(userId, inputs) {
    if (inputs.length === 0) return 0
    const { count } = await db.subject.createMany({
      data: inputs.map((input) => ({ userId, ...input })),
    })
    return count
  },

  async update(userId, id, input) {
    if (!uuid.safeParse(id).success) return false
    const scope = await writeScope(userId)
    const { count } = await db.subject.updateMany({
      where: { AND: [scope, { id }] },
      data: input,
    })
    return count > 0
  },

  async rename(userId, id, name) {
    if (!uuid.safeParse(id).success) return false
    const scope = await writeScope(userId)
    const { count } = await db.subject.updateMany({
      where: { AND: [scope, { id }] },
      data: { name },
    })
    return count > 0
  },

  async remove(userId, id) {
    if (!uuid.safeParse(id).success) return false
    const scope = await writeScope(userId)
    // Las claves foráneas (ON DELETE SET NULL) mandan archivos, documentos,
    // conversaciones y dudas de la materia al workspace General.
    const { count } = await db.subject.deleteMany({ where: { AND: [scope, { id }] } })
    return count > 0
  },
}

// --- Demo (memoria) --------------------------------------------------------
// Arranca vacío: solo guarda lo que la persona crea durante la sesión del servidor.

const globalForDemo = globalThis as unknown as {
  demoSubjects?: Map<string, SubjectRecord & { userId: string }>
}
const demoStore = (globalForDemo.demoSubjects ??= new Map())

const demoRepo: SubjectsRepo = {
  async list(userId) {
    return [...demoStore.values()]
      .filter((s) => s.userId === userId)
      .map(({ userId: _userId, ...s }) => ({
        ...s,
        fileCount: 0,
        conversationCount: 0,
        documentCount: 0,
        lastActivityAt: s.updatedAt,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'))
  },

  async get(userId, id) {
    const found = demoStore.get(id)
    if (!found || found.userId !== userId) return undefined
    const { userId: _userId, ...record } = found
    return record
  },

  async create(userId, input) {
    const id = crypto.randomUUID()
    const now = new Date()
    demoStore.set(id, { id, userId, ...input, createdAt: now, updatedAt: now })
    return { id }
  },

  async createMany(userId, inputs) {
    for (const input of inputs) await demoRepo.create(userId, input)
    return inputs.length
  },

  async update(userId, id, input) {
    const found = demoStore.get(id)
    if (!found || found.userId !== userId) return false
    demoStore.set(id, { ...found, ...input, updatedAt: new Date() })
    return true
  },

  async rename(userId, id, name) {
    const found = demoStore.get(id)
    if (!found || found.userId !== userId) return false
    demoStore.set(id, { ...found, name, updatedAt: new Date() })
    return true
  },

  async remove(userId, id) {
    const found = demoStore.get(id)
    if (!found || found.userId !== userId) return false
    return demoStore.delete(id)
  },
}

export function getSubjectsRepo(): SubjectsRepo {
  return isDatabaseConfigured ? postgresRepo : demoRepo
}
