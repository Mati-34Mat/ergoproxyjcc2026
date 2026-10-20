export const ROOT_ALIAS = 'Pregunta inicial'

/** Alias compacto: el mapa se vuelve ilegible con etiquetas largas. */
export const ALIAS_MAX = 24

/** Alias de los nodos del historial de dudas: tiene que entrar entero en la etiqueta del mapa (32). */
export const QUESTION_ALIAS_MAX = 28

export const MAX_PROPOSALS_PER_MESSAGE = 3
export const MAX_NODES_PER_CONVERSATION = 40
export const MAX_DEPTH = 5

/** Se compacta la rama cuando sus mensajes propios sin resumir superan alguno de estos límites. */
export const OWN_COMPACT_CHARS = 6000
export const OWN_COMPACT_MESSAGES = 14
export const KEEP_RECENT_MESSAGES = 6

/** El tramo compartido hasta la bifurcación se resume una sola vez si es más largo que esto. */
export const INHERITED_COMPACT_CHARS = 8000
export const KEEP_RECENT_INHERITED = 4

/** Tope duro de caracteres de historial que se envía al modelo. */
export const CONTEXT_BUDGET_CHARS = 24000

export const QUESTION_PREVIEW_CHARS = 160
