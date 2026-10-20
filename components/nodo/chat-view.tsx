'use client'

import { Check, Clock3, GitBranch, Plus, Send, Sparkles, X } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { Fragment, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { resolveAgentAction, setActiveNode } from '@/app/actions/agent-actions'
import { sendMessage } from '@/app/actions/chat'
import { createConversation } from '@/app/actions/conversations'
import { continueFromQuestionNode } from '@/app/actions/questions'
import { Markdown } from '@/components/chat/markdown'
import { HistoryOverlay, type HistoryNode } from '@/components/nodo/history-overlay'
import { pluralize } from '@/lib/format'

export type Session = { id: string; title: string; messageCount: number }

/**
 * Propuestas del agente pendientes de decisión. El agente nunca aplica nada:
 * acá se muestra la vista previa y la persona acepta o descarta.
 */
export type ProposedAction =
  | { id: string; kind: 'history'; title: string; description: string }
  | {
      id: string
      kind: 'folder'
      operationLabel: string
      reason: string
      title: string | null
      contentMd: string | null
      solutionMd: string | null
      targetTitle: string | null
      relatedTitle: string | null
      nodeTypeLabel: string | null
      edgeLabel: string | null
    }

export type ChatMessage = {
  id: string
  role: string
  content: string
  /** true si viene del camino compartido hasta la bifurcación de la rama activa. */
  inherited: boolean
  actions: ProposedAction[]
}

/** Rama interna activa cuando no es la principal de la sesión. */
export type ActiveBranch = { alias: string; rootId: string }

export function ChatView({
  subjectId,
  sessions,
  activeId,
  messages,
  nodes,
  branch,
  initialFocusId,
}: {
  subjectId: string
  sessions: Session[]
  activeId: string | null
  messages: ChatMessage[]
  nodes: HistoryNode[]
  branch: ActiveBranch | null
  initialFocusId: string | null
}) {
  const router = useRouter()
  const [question, setQuestion] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const [selectedNode, setSelectedNode] = useState<string | null>(initialFocusId)
  const [pending, startTransition] = useTransition()

  const activeSession = sessions.find((session) => session.id === activeId) ?? null
  const focusNode = nodes.find((node) => node.id === selectedNode) ?? null
  const branchStart = branch ? messages.findIndex((message) => !message.inherited) : -1

  /**
   * Bifurca en el servidor donde nació la duda y abre ese chat en la rama nueva. Un nodo sin sesión
   * de origen no tiene dónde bifurcar: queda como foco del próximo mensaje.
   */
  function continueFrom(id: string | null) {
    if (!id || pending) return
    startTransition(async () => {
      const result = await continueFromQuestionNode(id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setShowHistory(false)
      const conversationId = result.data?.conversationId
      if (!conversationId) {
        setSelectedNode(id)
        return
      }
      setSelectedNode(null)
      if (conversationId === activeId) router.refresh()
      else openSession(conversationId)
    })
  }

  function backToMain() {
    if (!activeId || !branch) return
    startTransition(async () => {
      const result = await setActiveNode(activeId, branch.rootId)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      router.refresh()
    })
  }

  const openSession = (id: string) => {
    router.push(`/subjects/${subjectId}?sesion=${id}`)
  }

  function newSession() {
    startTransition(async () => {
      const result = await createConversation(subjectId)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setQuestion('')
      if (result.data) openSession(result.data.id)
    })
  }

  function send() {
    const text = question.trim()
    if (!text || pending) return

    startTransition(async () => {
      // La primera pregunta crea la sesión: no hace falta abrirla a mano.
      let conversationId = activeId
      if (!conversationId) {
        const created = await createConversation(subjectId)
        if (!created.ok || !created.data) {
          toast.error(created.ok ? 'No pudimos crear la sesión.' : created.error)
          return
        }
        conversationId = created.data.id
      }

      // nodeId vacío: la rama activa se resuelve en el servidor. Si se eligió un nodo del
      // historial, el servidor bifurca ahí y esa rama pasa a ser la activa.
      const result = await sendMessage(conversationId, text, [], null, selectedNode)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setQuestion('')
      setSelectedNode(null)
      if (conversationId !== activeId) openSession(conversationId)
      else router.refresh()
    })
  }

  function resolve(actionId: string, decision: 'accept' | 'dismiss') {
    startTransition(async () => {
      const result = await resolveAgentAction(actionId, decision)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(decision === 'accept' ? 'Propuesta aplicada.' : 'Propuesta descartada.')
      router.refresh()
    })
  }

  return (
    <div className="chat-layout">
      <aside className="session-sidebar">
        <button type="button" className="new-session" onClick={newSession} disabled={pending}>
          <Plus size={16} /> Nueva sesión
        </button>
        <div className="sidebar-label">
          SESIONES <span>{sessions.length}</span>
        </div>
        {sessions.length === 0 && (
          <p className="sessions-empty">
            Todavía no hay sesiones. Creá una o escribí tu primera pregunta.
          </p>
        )}
        {sessions.map((session) => (
          <button
            key={session.id}
            type="button"
            className={session.id === activeId ? 'session active' : 'session'}
            onClick={() => openSession(session.id)}
          >
            <Clock3 size={15} />
            <span>{session.title}</span>
          </button>
        ))}
      </aside>

      <section className="chat-main">
        <div className="chat-header">
          <div>
            <span className="live-dot" />
            <strong>{activeSession?.title ?? 'Sin sesión activa'}</strong>
            <small>
              {activeSession
                ? pluralize(activeSession.messageCount, 'mensaje', 'mensajes')
                : 'Tu primera pregunta creará una sesión'}
            </small>
          </div>
          <button type="button" className="history-button" onClick={() => setShowHistory(true)}>
            <GitBranch size={15} /> Historial <span>{nodes.length}</span>
          </button>
        </div>

        <div className="messages">
          {messages.length === 0 ? (
            <div className="empty-chat">
              <div className="empty-icon">
                <Sparkles size={21} />
              </div>
              <h2>¿Qué querés entender?</h2>
              <p>Hacé una pregunta para empezar a construir tu mapa de aprendizaje.</p>
            </div>
          ) : (
            messages.map((message, index) => (
              <Fragment key={message.id}>
                {branch && index === branchStart && (
                  <div className="chat-date">RAMA «{branch.alias.toUpperCase()}»</div>
                )}
                <div className={`message-row ${message.role === 'assistant' ? 'ai' : 'user'}`}>
                  {message.role === 'assistant' ? (
                    <div className="ai-avatar">
                      <GitBranch size={14} />
                    </div>
                  ) : (
                    <div className="user-avatar">·</div>
                  )}
                  <div className="message-content">
                    <span className="message-label">
                      {message.role === 'assistant' ? 'ASISTENTE' : 'TÚ'}
                    </span>
                    {message.role === 'assistant' ? (
                      <Markdown>{message.content}</Markdown>
                    ) : (
                      <p>{message.content}</p>
                    )}
                    {message.actions.map((action) => (
                      <div key={action.id} className="action-card">
                        {action.kind === 'history' ? (
                          <div>
                            <span className="message-label">NODO PROPUESTO PARA EL HISTORIAL</span>
                            <strong>{action.title}</strong>
                            <p>{action.description}</p>
                          </div>
                        ) : (
                          <div>
                            <span className="message-label">
                              CAMBIO PROPUESTO EN LA CARPETA · {action.operationLabel}
                            </span>
                            <strong>
                              {action.title ??
                                action.targetTitle ??
                                'Relacionar apuntes'}
                            </strong>
                            <p>{action.reason}</p>
                            {action.nodeTypeLabel && (
                              <p className="action-meta">Tipo: {action.nodeTypeLabel}</p>
                            )}
                            {action.targetTitle && (
                              <p className="action-meta">
                                {action.relatedTitle
                                  ? `${action.targetTitle} ${action.edgeLabel ?? 'se relaciona con'} ${action.relatedTitle}`
                                  : `Sobre el apunte: ${action.targetTitle}`}
                              </p>
                            )}
                            {action.contentMd && (
                              <div className="action-preview">
                                <Markdown>{action.contentMd}</Markdown>
                              </div>
                            )}
                            {action.solutionMd && (
                              <div className="action-preview">
                                <span className="message-label">RESOLUCIÓN</span>
                                <Markdown>{action.solutionMd}</Markdown>
                              </div>
                            )}
                          </div>
                        )}
                        <div className="action-buttons">
                          <button
                            type="button"
                            className="button primary"
                            onClick={() => resolve(action.id, 'accept')}
                            disabled={pending}
                          >
                            <Check size={14} />{' '}
                            {action.kind === 'history' ? 'Agregar al historial' : 'Aplicar a la Carpeta'}
                          </button>
                          <button
                            type="button"
                            className="button secondary"
                            onClick={() => resolve(action.id, 'dismiss')}
                            disabled={pending}
                          >
                            Descartar
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </Fragment>
            ))
          )}
        </div>

        <div className="composer-wrap">
          {branch && !focusNode && (
            <div className="selected-context">
              <GitBranch size={13} /> En la rama <strong>{branch.alias}</strong>
              <button type="button" onClick={backToMain} disabled={pending}>
                Volver a la principal
              </button>
            </div>
          )}
          {focusNode && (
            <div className="selected-context">
              <GitBranch size={13} /> Continuando desde <strong>{focusNode.question}</strong>
              <button type="button" aria-label="Dejar de continuar desde este nodo" onClick={() => setSelectedNode(null)}>
                <X size={13} />
              </button>
            </div>
          )}
          <div className="composer">
            <input
              placeholder="Preguntale algo a la IA..."
              value={question}
              maxLength={4000}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') send()
              }}
            />
            <button type="button" onClick={send} disabled={pending} aria-label="Enviar pregunta">
              <Send size={17} />
            </button>
          </div>
          <small>
            {pending
              ? 'Pensando…'
              : 'Enter para enviar · Tus conversaciones se organizan automáticamente'}
          </small>
        </div>
      </section>

      {showHistory && (
        <HistoryOverlay
          nodes={nodes}
          selected={selectedNode}
          setSelected={setSelectedNode}
          onClose={() => setShowHistory(false)}
          onContinue={continueFrom}
        />
      )}
    </div>
  )
}
