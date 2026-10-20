import 'server-only'

import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'

const GATEWAY_DEFAULT_MODEL = 'openai/gpt-5-mini'
const OPENROUTER_DEFAULT_MODEL = 'openai/gpt-4.1-nano'
const OPENROUTER_RETRY_MODEL = 'openai/gpt-4o-mini'
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
const OPENCODE_DEFAULT_MODEL = 'big-pickle'
const OPENCODE_BASE_URL = 'https://opencode.ai/zen/v1'

export type LlmProvider = 'openrouter' | 'opencode-zen' | 'gateway-default'
type LlmSelection = { model: LanguageModel; modelId: string; provider: LlmProvider }

function openRouter(apiKey: string, modelId: string): LlmSelection {
  const provider = createOpenAICompatible({
    name: 'openrouter',
    baseURL: OPENROUTER_BASE_URL,
    apiKey,
    supportsStructuredOutputs: true,
  })
  return { model: provider.chatModel(modelId), modelId, provider: 'openrouter' }
}

function opencodeZen(apiKey: string, modelId: string): LlmSelection {
  const opencode = createOpenAICompatible({ name: 'opencode-zen', baseURL: OPENCODE_BASE_URL, apiKey })
  return { model: opencode.chatModel(modelId), modelId, provider: 'opencode-zen' }
}

export function openRouterKey() {
  return (
    process.env.OPENROUTER_API_KEY?.trim() ||
    process.env.VERCEL_API_KEY_2?.trim() ||
    process.env.VERCEL_API_KEY?.trim() ||
    undefined
  )
}

/**
 * Configuración del proveedor de LLM, leída solo en el servidor. Orden de prioridad:
 *
 *   OPENROUTER_API_KEY (o VERCEL_API_KEY_2 / VERCEL_API_KEY)  OpenRouter; el modelo es un id `proveedor/modelo`
 *   OPENCODE_API_KEY                                          OpenCode Zen; el modelo es p. ej. `big-pickle`
 *   (ninguna)                                                 AI Gateway con las credenciales del entorno de Vercel
 *   LLM_MODEL                                                 (opcional) id del modelo del proveedor elegido
 *
 * Las claves nunca se escriben en el código: solo se leen de variables de entorno.
 */
export function getLlmServerConfig(): LlmSelection {
  const configuredModel = process.env.LLM_MODEL?.trim()
  const routerKey = openRouterKey()
  const opencodeKey = process.env.OPENCODE_API_KEY?.trim()

  if (routerKey) {
    return openRouter(routerKey, configuredModel?.includes('/') ? configuredModel : OPENROUTER_DEFAULT_MODEL)
  }
  if (opencodeKey) {
    return opencodeZen(opencodeKey, configuredModel && !configuredModel.includes('/') ? configuredModel : OPENCODE_DEFAULT_MODEL)
  }
  const modelId = configuredModel?.includes('/') ? configuredModel : GATEWAY_DEFAULT_MODEL
  return { model: modelId, modelId, provider: 'gateway-default' }
}

/**
 * Proveedor alternativo cuando el principal rechaza la clave (401/402/403).
 * Devuelve null si no hay otro distinto al que ya falló.
 */
export function getLlmFallback(failed: LlmProvider): LlmSelection | null {
  const opencodeKey = process.env.OPENCODE_API_KEY?.trim()
  if (failed === 'openrouter') {
    return opencodeKey ? opencodeZen(opencodeKey, OPENCODE_DEFAULT_MODEL) : null
  }
  if (failed === 'opencode-zen') {
    return { model: GATEWAY_DEFAULT_MODEL, modelId: GATEWAY_DEFAULT_MODEL, provider: 'gateway-default' }
  }
  return null
}

/**
 * Otro modelo barato de OpenRouter para cuando el principal está saturado (429)
 * o falla del lado del proveedor (5xx). Devuelve null si no aplica.
 */
export function getLlmRetryModel(current: { provider: LlmProvider; modelId: string }): LlmSelection | null {
  const routerKey = openRouterKey()
  if (current.provider !== 'openrouter' || !routerKey || current.modelId === OPENROUTER_RETRY_MODEL) return null
  return openRouter(routerKey, OPENROUTER_RETRY_MODEL)
}

export type LlmStatus = { configured: boolean; model: string | null }

/** Versión segura para pasar a componentes. */
export function getLlmStatus(): LlmStatus {
  const { modelId } = getLlmServerConfig()
  return { configured: true, model: modelId }
}
