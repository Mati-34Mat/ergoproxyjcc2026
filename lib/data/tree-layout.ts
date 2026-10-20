/**
 * Posición inicial de un nodo nuevo en el canvas del historial.
 *
 * Las coordenadas son porcentajes (0-100) sobre el mundo del canvas, igual que
 * QuestionNode.posX / posY. Sin esto todos los nodos nacerían en (0, 0) y
 * quedarían apilados; después la persona los puede arrastrar donde quiera.
 */

const ROOT_Y = 12
const ROW_GAP = 18
const SIBLING_GAP = 15
const ROOTS_PER_ROW = 4
const MIN_X = 6
const MAX_X = 94
const MAX_Y = 92

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

export type NodePosition = { posX: number; posY: number }

export function nextNodePosition({
  parent,
  siblingCount,
}: {
  /** Nodo padre, o null si el nodo nuevo es una raíz. */
  parent: NodePosition | null
  /** Cuántos hermanos tiene ya (hijos del mismo padre, o raíces de la materia). */
  siblingCount: number
}): NodePosition {
  if (!parent) {
    // Las raíces se reparten en filas de ROOTS_PER_ROW; al llenarse una fila se baja a la
    // siguiente en vez de apilarlas todas contra el borde derecho.
    const column = siblingCount % ROOTS_PER_ROW
    const row = Math.floor(siblingCount / ROOTS_PER_ROW)
    return {
      posX: clamp(20 + column * 22, MIN_X, MAX_X),
      posY: clamp(ROOT_Y + row * ROW_GAP * 2, 0, MAX_Y),
    }
  }

  // Los hijos se abren en abanico alrededor del padre: derecha, izquierda, y
  // cada vez más lejos a medida que aparecen más hermanos.
  const step = Math.floor(siblingCount / 2) + 1
  const direction = siblingCount % 2 === 0 ? 1 : -1
  return {
    posX: clamp(parent.posX + direction * step * SIBLING_GAP, MIN_X, MAX_X),
    posY: clamp(parent.posY + ROW_GAP, 0, MAX_Y),
  }
}
