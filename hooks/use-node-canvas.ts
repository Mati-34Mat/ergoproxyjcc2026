'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Canvas de nodos con pan, zoom y arrastre, compartido por el árbol del historial
 * y el árbol resumen.
 *
 * Las posiciones de los nodos son porcentajes (0-100) sobre un mundo fijo, igual
 * que se guardan en la base (posX / posY). Mientras se arrastra solo cambia el
 * estado local; al soltar se avisa con `onMoveEnd` para persistir.
 */

export const WORLD_WIDTH = 1000
export const WORLD_HEIGHT = 600

const MIN_ZOOM = 0.25
const MAX_ZOOM = 2.5
const GRID_SIZE = 40
const PAN_STEP = 60

export type CanvasPoint = { x: number; y: number }
export type CanvasNode = { id: string; posX: number; posY: number }

type Camera = { x: number; y: number; zoom: number }
type Interaction =
  | { type: 'node'; id: string; offsetX: number; offsetY: number }
  | { type: 'pan'; startX: number; startY: number; originX: number; originY: number }

const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))

export const toPixels = (position: CanvasPoint): CanvasPoint => ({
  x: (position.x / 100) * WORLD_WIDTH,
  y: (position.y / 100) * WORLD_HEIGHT,
})

export function useNodeCanvas<T extends CanvasNode>({
  nodes,
  onMoveEnd,
  onEscape,
}: {
  nodes: T[]
  onMoveEnd?: (id: string, posX: number, posY: number) => void
  onEscape?: () => void
}) {
  const stageRef = useRef<HTMLDivElement>(null)
  const interactionRef = useRef<Interaction | null>(null)
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 1 })
  const cameraRef = useRef(camera)
  const [isPanning, setIsPanning] = useState(false)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [positions, setPositions] = useState<Record<string, CanvasPoint>>({})
  const positionsRef = useRef(positions)
  useEffect(() => {
    positionsRef.current = positions
  }, [positions])

  const onMoveEndRef = useRef(onMoveEnd)
  const onEscapeRef = useRef(onEscape)
  useEffect(() => {
    cameraRef.current = camera
    onMoveEndRef.current = onMoveEnd
    onEscapeRef.current = onEscape
  }, [camera, onMoveEnd, onEscape])

  const getPosition = useCallback(
    (node: T): CanvasPoint => positions[node.id] ?? { x: node.posX, y: node.posY },
    [positions],
  )

  const toWorld = useCallback((clientX: number, clientY: number): CanvasPoint => {
    const rect = stageRef.current?.getBoundingClientRect()
    const { x, y, zoom } = cameraRef.current
    if (!rect) return { x: 0, y: 0 }
    return { x: (clientX - rect.left - x) / zoom, y: (clientY - rect.top - y) / zoom }
  }, [])

  const zoomAt = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect) return
    const anchorX = (clientX ?? rect.left + rect.width / 2) - rect.left
    const anchorY = (clientY ?? rect.top + rect.height / 2) - rect.top
    setCamera((current) => {
      const zoom = clampZoom(current.zoom * factor)
      const ratio = zoom / current.zoom
      return {
        zoom,
        x: anchorX - (anchorX - current.x) * ratio,
        y: anchorY - (anchorY - current.y) * ratio,
      }
    })
  }, [])

  const fitView = useCallback(() => {
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect) return
    const points = nodes.map((node) => toPixels(getPosition(node)))
    if (points.length === 0) {
      setCamera({
        zoom: 1,
        x: rect.width / 2 - WORLD_WIDTH / 2,
        y: rect.height / 2 - WORLD_HEIGHT / 2,
      })
      return
    }
    const padding = 140
    const minX = Math.min(...points.map((p) => p.x)) - padding
    const maxX = Math.max(...points.map((p) => p.x)) + padding
    const minY = Math.min(...points.map((p) => p.y)) - padding
    const maxY = Math.max(...points.map((p) => p.y)) + padding
    const zoom = clampZoom(Math.min(rect.width / (maxX - minX), rect.height / (maxY - minY), 1.2))
    setCamera({
      zoom,
      x: rect.width / 2 - ((minX + maxX) / 2) * zoom,
      y: rect.height / 2 - ((minY + maxY) / 2) * zoom,
    })
  }, [nodes, getPosition])

  // Se encuadra una sola vez, al abrir: después manda la vista de la persona.
  const hasFitted = useRef(false)
  useEffect(() => {
    if (hasFitted.current) return
    hasFitted.current = true
    fitView()
  }, [fitView])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      if (event.ctrlKey || event.metaKey) {
        zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY)
      } else {
        setCamera((current) => ({
          ...current,
          x: current.x - event.deltaX,
          y: current.y - event.deltaY,
        }))
      }
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const interaction = interactionRef.current
      if (!interaction) return
      if (interaction.type === 'pan') {
        setCamera((current) => ({
          ...current,
          x: interaction.originX + event.clientX - interaction.startX,
          y: interaction.originY + event.clientY - interaction.startY,
        }))
        return
      }
      const world = toWorld(event.clientX, event.clientY)
      setPositions((prev) => ({
        ...prev,
        [interaction.id]: {
          x: ((world.x - interaction.offsetX) / WORLD_WIDTH) * 100,
          y: ((world.y - interaction.offsetY) / WORLD_HEIGHT) * 100,
        },
      }))
    }
    const stop = () => {
      const interaction = interactionRef.current
      interactionRef.current = null
      setIsPanning(false)
      setDraggingId(null)
      document.body.style.userSelect = ''
      if (interaction?.type === 'node') {
        const point = positionsRef.current[interaction.id]
        if (point) onMoveEndRef.current?.(interaction.id, point.x, point.y)
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
  }, [toWorld])

  const startPan = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if ((event.target as HTMLElement).closest('.tree-node, .concept-node, .tree-controls, .canvas-tools')) {
        return
      }
      interactionRef.current = {
        type: 'pan',
        startX: event.clientX,
        startY: event.clientY,
        originX: cameraRef.current.x,
        originY: cameraRef.current.y,
      }
      setIsPanning(true)
      document.body.style.userSelect = 'none'
    },
    [],
  )

  const startNodeDrag = useCallback(
    (event: React.PointerEvent<HTMLElement>, node: T) => {
      event.stopPropagation()
      const world = toWorld(event.clientX, event.clientY)
      const position = toPixels(getPosition(node))
      interactionRef.current = {
        type: 'node',
        id: node.id,
        offsetX: world.x - position.x,
        offsetY: world.y - position.y,
      }
      setDraggingId(node.id)
      document.body.style.userSelect = 'none'
    },
    [toWorld, getPosition],
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return
      const moves: Record<string, CanvasPoint> = {
        ArrowLeft: { x: PAN_STEP, y: 0 },
        ArrowRight: { x: -PAN_STEP, y: 0 },
        ArrowUp: { x: 0, y: PAN_STEP },
        ArrowDown: { x: 0, y: -PAN_STEP },
      }
      const delta = moves[event.key]
      if (delta) {
        event.preventDefault()
        setCamera((current) => ({ ...current, x: current.x + delta.x, y: current.y + delta.y }))
      } else if (event.key === '+' || event.key === '=') {
        zoomAt(1.15)
      } else if (event.key === '-') {
        zoomAt(1 / 1.15)
      } else if (event.key === '0') {
        fitView()
      } else if (event.key === 'Escape') {
        onEscapeRef.current?.()
      }
    },
    [zoomAt, fitView],
  )

  return {
    stageRef,
    camera,
    isPanning,
    draggingId,
    getPosition,
    startPan,
    startNodeDrag,
    handleKeyDown,
    zoomAt,
    fitView,
    /** Para que la grilla del fondo acompañe el pan y el zoom. */
    stageStyle: {
      backgroundSize: `${GRID_SIZE * camera.zoom}px ${GRID_SIZE * camera.zoom}px`,
      backgroundPosition: `${camera.x}px ${camera.y}px`,
    },
    worldStyle: {
      transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`,
    },
  }
}
