import { describe, expect, it } from 'vitest'
import { shortLabel } from '@/lib/tree/alias'
import { QUESTION_ALIAS_MAX } from '@/lib/tree/config'

describe('shortLabel', () => {
  it('deja intacto un alias que ya entra', () => {
    expect(shortLabel('Definición de derivada', QUESTION_ALIAS_MAX)).toBe('Definición de derivada')
  })

  it('corta en una palabra entera y nunca pasa el tope', () => {
    const out = shortLabel('Cómo funciona el algoritmo de ordenamiento burbuja', QUESTION_ALIAS_MAX)
    expect(out.length).toBeLessThanOrEqual(QUESTION_ALIAS_MAX)
    expect(out).toBe('Cómo funciona el algoritmo…')
  })

  it('normaliza espacios y corta una palabra larguísima', () => {
    expect(shortLabel('  hola   mundo  ', 28)).toBe('hola mundo')
    expect(shortLabel('electroencefalografistas', 10).length).toBeLessThanOrEqual(10)
  })
})
