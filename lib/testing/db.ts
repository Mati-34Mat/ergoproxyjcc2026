import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@/lib/generated/prisma/client'
import { normalizeConnectionString } from '@/lib/db/connection-string'

/**
 * Cliente Prisma para pruebas de integración. Se apunta a `TEST_DATABASE_URL`
 * (una base descartable con las migraciones aplicadas). Si no está definida, las
 * suites que lo usan se saltean para no depender de una base en cada `pnpm test`.
 */

export const hasTestDb = Boolean(process.env.TEST_DATABASE_URL)

export function testClient() {
  const adapter = new PrismaPg({
    connectionString: normalizeConnectionString(process.env.TEST_DATABASE_URL),
    max: 2,
  })
  return new PrismaClient({ adapter })
}

let counter = 0
export function uniqueEmail(prefix = 'test') {
  counter += 1
  return `${prefix}-${Date.now()}-${counter}@example.com`
}

/** Crea un usuario aislado y devuelve su id. El id lo genera Better Auth, no la DB. */
export async function createUser(db: PrismaClient) {
  const user = await db.user.create({
    data: { id: uniqueId(), email: uniqueEmail(), name: 'Test User' },
    select: { id: true },
  })
  return user.id
}

export function uniqueId() {
  return `test-user-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/** Borra los datos de un usuario de prueba (cascade). No toca datos de otros usuarios. */
export async function cleanupUser(db: PrismaClient, userId: string) {
  await db.user.delete({ where: { id: userId } }).catch(() => {})
}
