import 'server-only'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { APICallError, embed, embedMany, type EmbeddingModel } from 'ai'
import { openRouterKey } from '@/lib/llm/config'
import { EMBEDDING_DIMENSIONS, getRagConfig } from './config'

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
// Por debajo del límite de tokens por pedido de los proveedores, con fragmentos de hasta 4000 caracteres.
const EMBED_BATCH_SIZE = 64

export class EmbeddingError extends Error {}

function embeddingModel(modelId: string): EmbeddingModel {
  const apiKey = openRouterKey()
  if (!apiKey) return modelId // AI Gateway con las credenciales del entorno de Vercel
  return createOpenAICompatible({
    name: 'openrouter',
    baseURL: OPENROUTER_BASE_URL,
    apiKey,
  }).embeddingModel(modelId)
}

function describeFailure(error: unknown) {
  if (error instanceof EmbeddingError) return error.message
  const message = error instanceof Error ? error.message : ''
  if (/credit card|customer_verification_required/i.test(message)) {
    return 'AI Gateway necesita una tarjeta de crédito cargada en el equipo de Vercel. Cargala en Vercel (AI > Add credit card) o definí OPENROUTER_API_KEY.'
  }
  if (APICallError.isInstance(error)) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return 'El proveedor de embeddings rechazó la clave de acceso.'
    }
    if (error.statusCode === 402) return 'El proveedor de embeddings no tiene crédito disponible.'
    if (error.statusCode === 429) return 'El proveedor de embeddings está limitando las consultas. Probá de nuevo en unos minutos.'
  }
  return 'No se pudieron generar los embeddings. Probá de nuevo en unos minutos.'
}

function checkDimensions(vectors: number[][]) {
  for (const vector of vectors) {
    if (vector.length !== EMBEDDING_DIMENSIONS) {
      throw new EmbeddingError(
        `El modelo de embeddings devolvió ${vector.length} dimensiones y la base espera ${EMBEDDING_DIMENSIONS}. Elegí otro EMBEDDING_MODEL o ajustá la columna con una migración.`,
      )
    }
  }
}

export async function embedTexts(values: string[]): Promise<number[][]> {
  const model = embeddingModel(getRagConfig().embeddingModel)
  const providerOptions = { openaiCompatible: { dimensions: EMBEDDING_DIMENSIONS } }
  const vectors: number[][] = []
  try {
    for (let i = 0; i < values.length; i += EMBED_BATCH_SIZE) {
      const batch = values.slice(i, i + EMBED_BATCH_SIZE)
      const { embeddings } = await embedMany({ model, values: batch, providerOptions, maxRetries: 2 })
      checkDimensions(embeddings)
      vectors.push(...embeddings)
    }
  } catch (error) {
    if (!(error instanceof EmbeddingError)) console.error('[rag] embedding failed', error)
    throw new EmbeddingError(describeFailure(error))
  }
  return vectors
}

export async function embedQuery(value: string): Promise<number[]> {
  const model = embeddingModel(getRagConfig().embeddingModel)
  try {
    const { embedding } = await embed({
      model,
      value,
      providerOptions: { openaiCompatible: { dimensions: EMBEDDING_DIMENSIONS } },
      maxRetries: 2,
    })
    checkDimensions([embedding])
    return embedding
  } catch (error) {
    if (!(error instanceof EmbeddingError)) console.error('[rag] query embedding failed', error)
    throw new EmbeddingError(describeFailure(error))
  }
}

/** Formato de texto que pgvector acepta con `::vector`. */
export function toVectorLiteral(vector: number[]) {
  return `[${vector.join(',')}]`
}
