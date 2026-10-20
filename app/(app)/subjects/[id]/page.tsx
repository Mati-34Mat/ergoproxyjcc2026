import type { Metadata } from 'next'
import {
  ChatView,
  type ChatMessage,
  type ProposedAction,
  type Session,
} from '@/components/nodo/chat-view'
import type { HistoryNode } from '@/components/nodo/history-overlay'
import {
  getConversationHeader,
  getFolderGraph,
  listConversationQuestionNodes,
  listConversations,
} from '@/lib/data/queries'
import {
  FOLDER_EDGE_LABELS,
  FOLDER_NODE_LABELS,
  FOLDER_OPERATION_LABELS,
  parseProposalPayload,
  type FolderEdgeKind,
  type FolderNodeType,
} from '@/lib/llm/contract'
import { requireUser } from '@/lib/session'
import { ensureRootNode, loadBranch, loadTree, pickNodeId } from '@/lib/tree/branch'

export const metadata: Metadata = { title: 'Chat' }

export default async function SubjectChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ sesion?: string; desde?: string }>
}) {
  const { id } = await params
  const { sesion, desde } = await searchParams
  const user = await requireUser()

  const [conversations, folder] = await Promise.all([
    listConversations(user.id, id),
    getFolderGraph(user.id, id),
  ])

  // Sin sesión en la URL se abre la más reciente, que es la primera de la lista.
  const activeId = sesion ?? conversations[0]?.id ?? null
  const [active, nodes] = await Promise.all([
    activeId ? getConversationHeader(user.id, activeId) : Promise.resolve(undefined),
    listConversationQuestionNodes(user.id, activeId),
  ])

  // Se muestra la rama activa: el camino heredado hasta la bifurcación más sus mensajes propios.
  let branch: Awaited<ReturnType<typeof loadBranch>> | null = null
  if (active) {
    const rootId = await ensureRootNode(active.id, user.id)
    const tree = await loadTree(active.id, user.id)
    branch = await loadBranch(
      active.id,
      user.id,
      pickNodeId(tree, rootId, null, active.activeNodeId),
      tree,
    )
  }
  const branchTarget = branch?.path[branch.path.length - 1]

  const sessions: Session[] = conversations.map((conversation) => ({
    id: conversation.id,
    title: conversation.title,
    messageCount: conversation.messageCount,
  }))

  // Títulos de la Carpeta, para que la vista previa nombre los apuntes en lugar de ids.
  const folderTitles = new Map(folder.nodes.map((node) => [node.id, node.title]))

  const messages: ChatMessage[] = (branch?.visible ?? []).map(({ message, inherited }) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    inherited,
    // Solo se ofrecen las propuestas que siguen pendientes de decisión. Las ramas propuestas por el
    // modelo (formato viejo) no se ofrecen: ahora se bifurca continuando desde un nodo del historial.
    actions: message.agentActions.flatMap<ProposedAction>((action) => {
      if (action.status !== 'proposed') return []
      const proposal = parseProposalPayload(action.payload)
      if (!proposal) return []

      if (proposal.type === 'propose_question_node') {
        return [
          {
            id: action.id,
            kind: 'history',
            title: proposal.title,
            description: proposal.description,
          },
        ]
      }
      if (proposal.type !== 'propose_folder_change') return []

      return [
        {
          id: action.id,
          kind: 'folder',
          operationLabel: FOLDER_OPERATION_LABELS[proposal.operation],
          reason: proposal.reason,
          title: proposal.title,
          contentMd: proposal.content_md,
          solutionMd: proposal.solution_md,
          targetTitle: proposal.target_node_id
            ? (folderTitles.get(proposal.target_node_id) ?? null)
            : null,
          relatedTitle: proposal.related_node_id
            ? (folderTitles.get(proposal.related_node_id) ?? null)
            : null,
          nodeTypeLabel: proposal.node_type
            ? FOLDER_NODE_LABELS[proposal.node_type as FolderNodeType]
            : null,
          edgeLabel: proposal.edge_kind
            ? FOLDER_EDGE_LABELS[proposal.edge_kind as FolderEdgeKind]
            : null,
        },
      ]
    }),
  }))

  const historyNodes: HistoryNode[] = nodes.map((node) => ({
    id: node.id,
    question: node.question,
    answerSummary: node.answerSummary,
    parentId: node.parentId,
    conversationId: node.conversationId,
    posX: node.posX,
    posY: node.posY,
    status: node.status,
  }))

  const resolvedActiveId = active ? activeId : (conversations[0]?.id ?? null)
  return (
    <ChatView
      // Se remonta al cambiar de sesión para tomar el nodo de `?desde=` como punto de partida.
      key={`${resolvedActiveId}:${desde ?? ''}`}
      subjectId={id}
      sessions={sessions}
      activeId={resolvedActiveId}
      messages={messages}
      nodes={historyNodes}
      branch={
        branch && branchTarget && branch.path.length > 1
          ? { alias: branchTarget.alias, rootId: branch.path[0].id }
          : null
      }
      initialFocusId={desde && historyNodes.some((node) => node.id === desde) ? desde : null}
    />
  )
}
