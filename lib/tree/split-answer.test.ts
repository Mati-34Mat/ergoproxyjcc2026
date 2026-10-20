import { describe, expect, it } from 'vitest'
import { splitAnswerByHeadings } from './split-answer'

const reply = `Claro, te explico:

### ¿Qué es una serie de Taylor?
Una serie de Taylor es una expansión.

### ¿Para qué sirve el teorema fundamental del cálculo?
Conecta derivación e integración.`

describe('splitAnswerByHeadings', () => {
  it('asigna cada sección a su nodo por título, sin importar el orden', () => {
    expect(splitAnswerByHeadings(reply, ['Teorema fundamental del…', 'Serie de Taylor'])).toEqual([
      '### ¿Para qué sirve el teorema fundamental del cálculo?\nConecta derivación e integración.',
      '### ¿Qué es una serie de Taylor?\nUna serie de Taylor es una expansión.',
    ])
  })

  it('suma una sección extra a la anterior', () => {
    const parts = splitAnswerByHeadings(`# Punteros\nA\n# Pila y cola\nB\n# Tabla hash\nC`, [
      'Punteros y memoria',
      'Tabla hash',
    ])
    expect(parts).toEqual(['# Punteros\nA\n\n# Pila y cola\nB', '# Tabla hash\nC'])
  })

  it('no divide si faltan secciones', () => {
    expect(splitAnswerByHeadings('Sin títulos.', ['Uno', 'Dos'])).toBeNull()
  })
})
