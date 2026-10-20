'use client'

import { ArrowUpRight, Folder, Pencil, Plus, X } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { createSubject, renameSubject } from '@/app/actions/subjects'
import { formatRelative, pluralize } from '@/lib/format'
import { COLOR_KEYS, DEFAULT_ICON } from '@/lib/workspace'

export type SubjectCard = {
  id: string
  name: string
  color: string
  fileCount: number
  conversationCount: number
  lastActivityAt: string
}

type ModalState = { mode: 'create' } | { mode: 'rename'; id: string } | null

export function SubjectGrid({ subjects }: { subjects: SubjectCard[] }) {
  const router = useRouter()
  const [modal, setModal] = useState<ModalState>(null)
  const [name, setName] = useState('')
  const [pending, startTransition] = useTransition()

  const renaming = modal?.mode === 'rename'

  function openCreate() {
    setName('')
    setModal({ mode: 'create' })
  }

  function openRename(subject: SubjectCard) {
    setName(subject.name)
    setModal({ mode: 'rename', id: subject.id })
  }

  function close() {
    setModal(null)
    setName('')
  }

  function submit() {
    const trimmed = name.trim()
    if (!modal || !trimmed || pending) return

    startTransition(async () => {
      if (modal.mode === 'rename') {
        const result = await renameSubject(modal.id, trimmed)
        if (!result.ok) {
          toast.error(result.error)
          return
        }
        toast.success('Materia renombrada.')
      } else {
        // El color rota según cuántas materias haya, para que la grilla no quede toda igual.
        const formData = new FormData()
        formData.set('name', trimmed)
        formData.set('code', '')
        formData.set('description', '')
        formData.set('color', COLOR_KEYS[subjects.length % COLOR_KEYS.length])
        formData.set('icon', DEFAULT_ICON)

        const result = await createSubject(formData)
        if (!result.ok) {
          toast.error(result.error)
          return
        }
      }
      close()
      router.refresh()
    })
  }

  return (
    <>
      <div className="subject-grid">
        <button type="button" className="new-subject-card" onClick={openCreate}>
          <span>
            <Plus size={21} />
          </span>
          <strong>Nueva materia</strong>
          <small>Empezá a organizar</small>
        </button>
        {subjects.map((subject) => (
          <div key={subject.id} className="subject-card-wrap">
            <button
              type="button"
              className="subject-card"
              onClick={() => router.push(`/subjects/${subject.id}`)}
            >
              <div className={`subject-icon ${subject.color}`}>
                {subject.name.trim()[0]?.toUpperCase() ?? '·'}
              </div>
              <div className="subject-info">
                <strong>{subject.name}</strong>
                <span>
                  {subject.conversationCount === 0
                    ? 'Sin sesiones'
                    : pluralize(subject.conversationCount, 'sesión', 'sesiones')}
                </span>
              </div>
              <div className="card-arrow">
                <ArrowUpRight size={17} />
              </div>
              <div className="card-footer">
                <span>
                  <Folder size={13} /> {pluralize(subject.fileCount, 'archivo', 'archivos')}
                </span>
                <span>{formatRelative(new Date(subject.lastActivityAt))}</span>
              </div>
            </button>
            <button
              type="button"
              className="subject-rename"
              aria-label={`Renombrar ${subject.name}`}
              title="Renombrar"
              onClick={() => openRename(subject)}
            >
              <Pencil size={14} />
            </button>
          </div>
        ))}
      </div>

      {modal && (
        <div className="modal-backdrop" onPointerDown={close}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="materia-modal-titulo"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button type="button" className="close-modal" aria-label="Cerrar" onClick={close}>
              <X size={18} />
            </button>
            <div className="modal-icon">{renaming ? <Pencil size={20} /> : <Plus size={20} />}</div>
            <h2 id="materia-modal-titulo">{renaming ? 'Renombrar materia' : 'Crear nueva materia'}</h2>
            <p>
              {renaming
                ? 'Tus sesiones, archivos y apuntes se mantienen.'
                : 'Organizá tus sesiones y materiales por materia.'}
            </p>
            <input
              autoFocus
              placeholder="Nombre de la materia"
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) submit()
                if (event.key === 'Escape') close()
              }}
            />
            <div className="modal-actions">
              <button type="button" className="button secondary" onClick={close}>
                Cancelar
              </button>
              <button
                type="button"
                className="button primary"
                onClick={submit}
                disabled={pending || name.trim().length === 0}
              >
                {pending ? 'Guardando…' : renaming ? 'Guardar' : 'Crear materia'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
