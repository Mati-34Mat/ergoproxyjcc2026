/**
 * Reparte una respuesta en Markdown con varias dudas en una sección por nodo del historial,
 * usando sus títulos (#, ##, ###…). Devuelve null si no se puede asignar una sección distinta a
 * cada nodo: en ese caso la respuesta queda entera en un solo mensaje.
 */

const HEADING = /^(#{1,4})\s+(.+?)\s*#*\s*$/

const tokens = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/…/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4)
    .map((t) => t.slice(0, 5))

function overlap(a: string, b: string) {
  const set = new Set(tokens(b))
  return tokens(a).filter((t) => set.has(t)).length
}

export function splitAnswerByHeadings(markdown: string, titles: string[]): string[] | null {
  if (titles.length < 2) return null
  const lines = markdown.split('\n')
  const levels = lines.flatMap((line) => {
    const match = HEADING.exec(line)
    return match ? [match[1].length] : []
  })
  if (levels.length < titles.length) return null
  const level = Math.min(...levels)

  const sections: { heading: string; body: string[] }[] = []
  for (const line of lines) {
    const match = HEADING.exec(line)
    if (match && match[1].length === level) sections.push({ heading: match[2], body: [line] })
    else sections.at(-1)?.body.push(line)
  }
  if (sections.length < titles.length) return null

  // Cada nodo toma la sección que más palabras comparte con su título; si los títulos no
  // coinciden con nada y la cantidad es la misma, se reparten en orden.
  const owner = new Array<number>(sections.length).fill(-1)
  const pairs = titles
    .flatMap((title, node) => sections.map((s, section) => ({ node, section, score: overlap(title, s.heading) })))
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
  const assigned = new Set<number>()
  for (const p of pairs) {
    if (assigned.has(p.node) || owner[p.section] !== -1) continue
    owner[p.section] = p.node
    assigned.add(p.node)
  }
  if (assigned.size < titles.length) {
    if (sections.length !== titles.length) return null
    owner.forEach((_, i) => (owner[i] = i))
  }

  // Una sección sin dueño (un tema extra) se suma a la sección anterior.
  const parts = titles.map(() => [] as string[])
  let last = owner.find((o) => o !== -1) ?? 0
  sections.forEach((section, i) => {
    if (owner[i] !== -1) last = owner[i]
    parts[last].push(section.body.join('\n').trim())
  })
  const result = parts.map((p) => p.join('\n\n').trim())
  return result.every(Boolean) ? result : null
}
