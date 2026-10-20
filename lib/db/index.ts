import 'server-only'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@/lib/generated/prisma/client'
import { normalizeConnectionString } from '@/lib/db/connection-string'

const globalForDb = globalThis as unknown as { prisma?: PrismaClient }

/**
 * Conexiones simultáneas del pool. DATABASE_POOL_MAX=1 hace falta con `prisma dev` (Postgres local
 * sobre PGlite): cierra las conexiones de más y las consultas en paralelo fallan con ConnectionClosed.
 */
function poolMax() {
  const parsed = Number.parseInt(process.env.DATABASE_POOL_MAX ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5
}

function createClient() {
  const adapter = new PrismaPg({
    connectionString: normalizeConnectionString(process.env.DATABASE_URL),
    max: poolMax(),
  })
  return new PrismaClient({ adapter })
}

// Una única instancia compartida entre Better Auth y la app (se reutiliza en HMR).
export const db = globalForDb.prisma ?? createClient()

if (process.env.NODE_ENV !== 'production') globalForDb.prisma = db
