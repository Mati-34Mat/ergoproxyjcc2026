import { describe, expect, it } from 'vitest'
import { normalizeConnectionString } from './connection-string'

const base = 'postgresql://user:pass@host.neon.tech/db'

describe('normalizeConnectionString', () => {
  it.each(['require', 'prefer', 'verify-ca'])('convierte sslmode=%s en verify-full', (mode) => {
    const result = normalizeConnectionString(`${base}?sslmode=${mode}`)
    expect(new URL(result!).searchParams.get('sslmode')).toBe('verify-full')
  })

  it('conserva el resto de los parámetros', () => {
    const result = normalizeConnectionString(`${base}?sslmode=require&channel_binding=require`)
    const params = new URL(result!).searchParams
    expect(params.get('sslmode')).toBe('verify-full')
    expect(params.get('channel_binding')).toBe('require')
  })

  it('no toca verify-full, disable ni URLs sin sslmode', () => {
    expect(normalizeConnectionString(`${base}?sslmode=verify-full`)).toBe(`${base}?sslmode=verify-full`)
    expect(normalizeConnectionString(`${base}?sslmode=disable`)).toBe(`${base}?sslmode=disable`)
    expect(normalizeConnectionString(base)).toBe(base)
  })

  it('respeta uselibpqcompat', () => {
    const url = `${base}?uselibpqcompat=true&sslmode=require`
    expect(normalizeConnectionString(url)).toBe(url)
  })

  it('devuelve valores vacíos o inválidos sin cambios', () => {
    expect(normalizeConnectionString(undefined)).toBeUndefined()
    expect(normalizeConnectionString('no-es-una-url')).toBe('no-es-una-url')
  })
})
