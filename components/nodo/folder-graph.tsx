'use client'

import {
  Check,
  GitBranch,
  LayoutGrid,
  Link2,
  Plus,
  Search,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, useTransition } from 'react'
import { toast } from 'sonner'
import {
  connectFolderNodes,
  createFolderNode,
  deleteFolderNode,
  disconnectFolderNodes,
  moveFolderNode,
  searchFolder,
  updateFolderNode,
} from '@/app/actions/folder'
import { Markdown } from '@/components/chat/markdown'
import { toPixels, useNodeCanvas } from '@/hooks/use-node-canvas'
import {
  FOLDER_EDGE_KINDS,
  FOLDER_EDGE_LABELS,
  FOLDER_NODE_LABELS,
  FOLDER_NODE_TYPES,
  type FolderEdgeKind,
  type FolderNodeType,
} from '@/lib/llm/contract'

export type FolderNodeView = {
  id: string
  title: string
  type: string
  contentMd: string
  posX: number
  posY: number
  origin: string
  updatedAt: string
  references: { id: string; label: string }[]
}

export type FolderEdgeView = { id: string; fromId: string; toId: string; kind: string }

const typeLabel = (type: string) =>
  FOLDER_NODE_LABELS[type as FolderNodeType] ?? FOLDER_NODE_LABELS.note

export function FolderGraph({
  subjectId,
  nodes,
  edges,
}: {
  subjectId: string
  nodes: FolderNodeView[]
  edges: FolderEdgeView[]
}) {
  const router = useRouter()
  const [selected, setSelected] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  // Borrador del apunte abierto. Se reinicia al cambiar de nodo.
  const [draft, setDraft] = useState<{ title: string; contentMd: string; type: string } | null>(
    null,
  )
  const [preview, setPreview] = useState(false)
  const [connectFrom, setConnectFrom] = useState<string | null>(null)
  const [connectKind, setConnectKind] = useState<FolderEdgeKind>('relates')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ id: string; title: string; type: string }[] | null>(null)

  const selectedNode = nodes.find((node) => node.id === selected) ?? null
  const notePanelRef = useRef<HTMLDivElement>(null)

  // El panel se dibuja debajo del canvas: en pantallas bajas queda fuera de vista.
  const panelReady = selected !== null && draft !== null
  useEffect(() => {
    if (!panelReady) return
    notePanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [selected, panelReady])

  const canvas = useNodeCanvas({
    nodes,
    onMoveEnd: (id, posX, posY) => void moveFolderNode(id, posX, posY),
    onEscape: () => {
      if (connectFrom) setConnectFrom(null)
      else setSelected(null)
    },
  })

  // Al abrir otro apunte se carga su contenido en el editor.
  useEffect(() => {
    setDraft(
      selectedNode
        ? {
            title: selectedNode.title,
            contentMd: selectedNode.contentMd,
            type: selectedNode.type,
          }
        : null,
    )
    setPreview(false)
  }, [selectedNode?.id, selectedNode?.updatedAt])

  const dirty =
    !!draft &&
    !!selectedNode &&
    (draft.title !== selectedNode.title ||
      draft.contentMd !== selectedNode.contentMd ||
      draft.type !== selectedNode.type)

  function handleNodeClick(id: string) {
    // En modo conectar, el primer click elige origen y el segundo crea la relación.
    if (connectFrom) {
      if (connectFrom === id) {
        setConnectFrom(null)
        return
      }
      const from = connectFrom
      startTransition(async () => {
        const result = await connectFolderNodes(from, id, connectKind)
        if (!result.ok) {
          toast.error(result.error)
          return
        }
        toast.success('Apuntes relacionados.')
        setConnectFrom(null)
        router.refresh()
      })
      return
    }
    setSelected(id)
  }

  function addNode(parentId: string | null) {
    const title = window.prompt(
      parentId ? 'Título del apunte, dentro del seleccionado' : 'Título del apunte nuevo',
    )
    if (!title?.trim()) return
    startTransition(async () => {
      const result = await createFolderNode(subjectId, title, 'concept', parentId)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      if (result.data) setSelected(result.data.id)
      router.refresh()
    })
  }

  function save() {
    if (!draft || !selectedNode) return
    startTransition(async () => {
      const result = await updateFolderNode(
        selectedNode.id,
        draft.title,
        draft.contentMd,
        draft.type,
      )
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Apunte guardado.')
      router.refresh()
    })
  }

  function remove(node: FolderNodeView) {
    const related = edges.filter((edge) => edge.fromId === node.id || edge.toId === node.id).length
    const warning = related
      ? `\n\nTambién se borran sus ${related} ${related === 1 ? 'relación' : 'relaciones'}. Los otros apuntes quedan.`
      : ''
    if (!window.confirm(`¿Borrar «${node.title}»?${warning}`)) return

    startTransition(async () => {
      const result = await deleteFolderNode(node.id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setSelected(null)
      toast.success('Apunte borrado.')
      router.refresh()
    })
  }

  function disconnect(edgeId: string) {
    startTransition(async () => {
      const result = await disconnectFolderNodes(edgeId)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      router.refresh()
    })
  }

  function runSearch(value: string) {
    setQuery(value)
    if (!value.trim()) {
      setResults(null)
      return
    }
    startTransition(async () => {
      const result = await searchFolder(subjectId, value)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setResults(result.data?.results ?? [])
    })
  }

  const relations = selectedNode
    ? edges
        .filter((edge) => edge.fromId === selectedNode.id || edge.toId === selectedNode.id)
        .map((edge) => {
          const outgoing = edge.fromId === selectedNode.id
          const other = nodes.find((node) => node.id === (outgoing ? edge.toId : edge.fromId))
          return { edge, other, outgoing }
        })
        .filter((relation) => relation.other)
    : []

  return (
    <section className="folder-view">
      <div className="folder-toolbar">
        <div>
          <div className="eyebrow">CARPETA DE LA MATERIA</div>
          <h2>Lo que estás aprendiendo</h2>
          <p>
            Tus conceptos, ejercicios y apuntes, con las relaciones que vos armás. Es independiente
            del historial: un concepto vive una vez acá, aunque lo toques en varias sesiones.
          </p>
        </div>
        <div className="toolbar-actions">
          <div className="folder-search">
            <Search size={14} />
            <input
              placeholder="Buscar por título o contenido"
              value={query}
              onChange={(event) => runSearch(event.target.value)}
            />
            {query && (
              <button type="button" aria-label="Limpiar búsqueda" onClick={() => runSearch('')}>
                <X size={13} />
              </button>
            )}
          </div>
          <button
            type="button"
            className="tool-button"
            onClick={() => addNode(selected)}
            disabled={pending}
          >
            <Plus size={15} /> {selected ? 'Apunte dentro' : 'Nuevo apunte'}
          </button>
          <button
            type="button"
            className={connectFrom ? 'button primary' : 'tool-button'}
            onClick={() => setConnectFrom(connectFrom ? null : (selected ?? null))}
            disabled={pending || (!connectFrom && !selected)}
          >
            <Link2 size={15} /> {connectFrom ? 'Elegí el destino' : 'Conectar'}
          </button>
        </div>
      </div>

      {connectFrom && (
        <div className="summary-banner">
          <Link2 size={16} />
          <span>
            Relación «{FOLDER_EDGE_LABELS[connectKind]}» desde{' '}
            <strong>{nodes.find((node) => node.id === connectFrom)?.title}</strong>. Tocá el apunte
            de destino.
          </span>
          <select
            value={connectKind}
            onChange={(event) => setConnectKind(event.target.value as FolderEdgeKind)}
          >
            {FOLDER_EDGE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {FOLDER_EDGE_LABELS[kind]}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => setConnectFrom(null)} aria-label="Cancelar">
            <X size={15} />
          </button>
        </div>
      )}

      {results && (
        <div className="folder-results">
          {results.length === 0 ? (
            <span>Ningún apunte coincide con «{query}».</span>
          ) : (
            results.map((result) => (
              <button
                key={result.id}
                type="button"
                className="folder-result"
                onClick={() => {
                  setSelected(result.id)
                  setResults(null)
                  setQuery('')
                }}
              >
                <span className={`node-chip ${result.type}`}>{typeLabel(result.type)}</span>
                {result.title}
              </button>
            ))
          )}
        </div>
      )}

      {nodes.length === 0 && !results && (
        <div className="summary-banner">
          <GitBranch size={16} />
          <span>
            La Carpeta está vacía. Creá un apunte, o seguí chateando: el tutor va a proponerte
            guardar lo que valga la pena.
          </span>
        </div>
      )}

      <div
        ref={canvas.stageRef}
        className={`concept-canvas infinite-canvas ${canvas.isPanning ? 'is-panning' : ''}`}
        tabIndex={0}
        role="application"
        aria-label="Grafo de la Carpeta. Flechas para mover la vista, más y menos para zoom, 0 para centrar."
        onPointerDown={canvas.startPan}
        onKeyDown={canvas.handleKeyDown}
        style={canvas.stageStyle}
      >
        <div className="tree-world" style={canvas.worldStyle}>
          <svg className="tree-lines" width="1" height="1" aria-hidden="true">
            {edges.map((edge) => {
              const from = nodes.find((node) => node.id === edge.fromId)
              const to = nodes.find((node) => node.id === edge.toId)
              if (!from || !to) return null
              const a = toPixels(canvas.getPosition(from))
              const b = toPixels(canvas.getPosition(to))
              return (
                <path
                  key={edge.id}
                  className={`edge-${edge.kind}`}
                  d={`M${a.x} ${a.y} C${a.x} ${(a.y + b.y) / 2} ${b.x} ${(a.y + b.y) / 2} ${b.x} ${b.y}`}
                />
              )
            })}
          </svg>
          {nodes.map((node) => {
            const position = toPixels(canvas.getPosition(node))
            return (
              <button
                key={node.id}
                type="button"
                className={[
                  'concept-node',
                  `type-${node.type}`,
                  selected === node.id ? 'selected' : '',
                  connectFrom === node.id ? 'connect-source' : '',
                  node.origin === 'manual' ? 'is-manual' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={{
                  left: `${position.x}px`,
                  top: `${position.y}px`,
                  cursor: canvas.draggingId === node.id ? 'grabbing' : 'grab',
                  touchAction: 'none',
                }}
                onPointerDown={(event) => canvas.startNodeDrag(event, node)}
                onClick={() => handleNodeClick(node.id)}
              >
                <span className={`node-chip ${node.type}`}>{typeLabel(node.type)}</span>
                <span className="node-title">{node.title}</span>
              </button>
            )
          })}
        </div>
        <div className="canvas-tools">
          <button type="button" onClick={() => canvas.zoomAt(1.2)} aria-label="Acercar">
            <ZoomIn size={15} />
          </button>
          <span className="zoom-value">{Math.round(canvas.camera.zoom * 100)}%</span>
          <button type="button" onClick={() => canvas.zoomAt(1 / 1.2)} aria-label="Alejar">
            <ZoomOut size={15} />
          </button>
          <button type="button" onClick={canvas.fitView} aria-label="Centrar grafo">
            <LayoutGrid size={15} />
          </button>
        </div>
        <div className="canvas-hint">
          Tocá un apunte para abrirlo · Arrastrá para moverlo · Ctrl + rueda para zoom
        </div>
      </div>

      {selectedNode && draft && (
        <div className="note-panel" ref={notePanelRef}>
          <div className="note-head">
            <div className="note-head-main">
              <span className="detail-label">
                {selectedNode.origin === 'manual' ? 'APUNTE TUYO' : 'PROPUESTO POR LA IA'}
              </span>
              <input
                className="note-title"
                value={draft.title}
                maxLength={80}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              />
            </div>
            <select
              value={draft.type}
              onChange={(event) => setDraft({ ...draft, type: event.target.value })}
            >
              {FOLDER_NODE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {FOLDER_NODE_LABELS[type]}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="close-overlay"
              aria-label="Cerrar apunte"
              onClick={() => setSelected(null)}
            >
              <X size={16} />
            </button>
          </div>

          <div className="note-tabs">
            <button
              type="button"
              className={preview ? 'tab' : 'tab active'}
              onClick={() => setPreview(false)}
            >
              Escribir
            </button>
            <button
              type="button"
              className={preview ? 'tab active' : 'tab'}
              onClick={() => setPreview(true)}
            >
              Ver
            </button>
          </div>

          {preview ? (
            <div className="note-preview">
              {draft.contentMd.trim() ? (
                <Markdown>{draft.contentMd}</Markdown>
              ) : (
                <p className="note-empty">Este apunte todavía no tiene contenido.</p>
              )}
            </div>
          ) : (
            <textarea
              className="note-editor"
              value={draft.contentMd}
              placeholder="Escribí el apunte en Markdown: títulos con #, listas con -, fórmulas en bloques de código…"
              onChange={(event) => setDraft({ ...draft, contentMd: event.target.value })}
            />
          )}

          {relations.length > 0 && (
            <div className="note-relations">
              <span className="detail-label">RELACIONES</span>
              {relations.map(({ edge, other, outgoing }) => (
                <div key={edge.id} className="note-relation">
                  <span>
                    {outgoing ? '' : `${other!.title} `}
                    <em>{FOLDER_EDGE_LABELS[edge.kind as FolderEdgeKind] ?? edge.kind}</em>
                    {outgoing ? ` ${other!.title}` : ''}
                  </span>
                  <button
                    type="button"
                    onClick={() => disconnect(edge.id)}
                    disabled={pending}
                    aria-label="Quitar relación"
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {selectedNode.references.length > 0 && (
            <div className="note-relations">
              <span className="detail-label">DE DÓNDE SALIÓ</span>
              {selectedNode.references.map((reference) => (
                <div key={reference.id} className="note-relation">
                  <span>{reference.label}</span>
                </div>
              ))}
            </div>
          )}

          <div className="note-actions">
            <button
              type="button"
              className="tool-button"
              onClick={() => remove(selectedNode)}
              disabled={pending}
            >
              <Trash2 size={15} /> Borrar apunte
            </button>
            <button
              type="button"
              className="button primary"
              onClick={save}
              disabled={pending || !dirty}
            >
              <Check size={15} /> {dirty ? 'Guardar cambios' : 'Guardado'}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
