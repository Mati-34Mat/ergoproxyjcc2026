export type TextChunk = { chunkIndex: number; content: string }

// Fragmentos más cortos que esto casi nunca aportan contexto (números de página, títulos sueltos).
const MIN_CHUNK_CHARS = 20

/**
 * Parte el texto de UNA página en fragmentos de hasta `size` caracteres, con `overlap`
 * caracteres compartidos entre contiguos. Nunca cruza páginas: así cada fragmento
 * pertenece a una sola página y la cita por número es exacta.
 *
 * Conserva los saltos de línea del texto original (el código y los enunciados dependen de
 * ellos). Corta de preferencia en salto de párrafo, luego en salto de línea, luego fin de
 * oración y luego espacio, sin retroceder más de ~40% del tamaño para no generar fragmentos
 * diminutos.
 */
export function chunkPageText(text: string, size: number, overlap: number): TextChunk[] {
  const clean = text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (clean.length < MIN_CHUNK_CHARS) return []
  if (clean.length <= size) return [{ chunkIndex: 0, content: clean }]

  const chunks: TextChunk[] = []
  const minEnd = Math.floor(size * 0.6)
  let start = 0

  while (start < clean.length) {
    let end = Math.min(start + size, clean.length)
    if (end < clean.length) {
      const window = clean.slice(start, end)
      const paragraph = window.lastIndexOf('\n\n')
      const line = window.lastIndexOf('\n')
      const sentence = Math.max(
        window.lastIndexOf('. '),
        window.lastIndexOf('? '),
        window.lastIndexOf('! '),
        window.lastIndexOf('; '),
      )
      const space = window.lastIndexOf(' ')
      if (paragraph >= minEnd) end = start + paragraph
      else if (line >= minEnd) end = start + line
      else if (sentence >= minEnd) end = start + sentence + 1
      else if (space >= minEnd) end = start + space
    }

    const content = clean.slice(start, end).trim()
    if (content.length >= MIN_CHUNK_CHARS) chunks.push({ chunkIndex: chunks.length, content })
    if (end >= clean.length) break

    // El siguiente fragmento arranca al inicio de una línea (o en una palabra completa) y siempre avanza.
    let next = Math.max(end - overlap, start + 1)
    const lineBoundary = clean.indexOf('\n', next)
    const spaceBoundary = clean.indexOf(' ', next)
    if (lineBoundary !== -1 && lineBoundary < end) next = lineBoundary + 1
    else if (spaceBoundary !== -1 && spaceBoundary < end) next = spaceBoundary + 1
    start = next
  }

  return chunks
}
