'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { getSubjectsRepo, type SubjectInput } from '@/lib/data/subjects-repo'
import { getUserId } from '@/lib/session'
import type { ActionResult } from '@/lib/types'
import {
  COLOR_KEYS,
  DEFAULT_ICON,
  GENERAL_WORKSPACE_ID,
  ICON_KEYS,
} from '@/lib/workspace'

const subjectSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Ingresá el nombre de la materia.')
    .max(120, 'El nombre admite hasta 120 caracteres.'),
  code: z.string().trim().max(20, 'El código admite hasta 20 caracteres.'),
  description: z
    .string()
    .trim()
    .max(500, 'La descripción admite hasta 500 caracteres.'),
  color: z.enum(COLOR_KEYS, 'Elegí un color de la lista.'),
  icon: z.enum(ICON_KEYS, 'Elegí un icono de la lista.'),
})

function parseSubject(formData: FormData) {
  const parsed = subjectSchema.safeParse({
    name: formData.get('name') ?? '',
    code: formData.get('code') ?? '',
    description: formData.get('description') ?? '',
    color: formData.get('color') ?? '',
    icon: formData.get('icon') ?? '',
  })
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0].message } as const
  }
  const { name, code, description, color, icon } = parsed.data
  const input: SubjectInput = {
    name,
    code: code || null,
    description: description || null,
    color,
    icon,
  }
  return { ok: true, input } as const
}

export async function createSubject(
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  const userId = await getUserId()
  const parsed = parseSubject(formData)
  if (!parsed.ok) return { ok: false, error: parsed.error }

  const { id } = await getSubjectsRepo().create(userId, parsed.input)
  revalidatePath('/', 'layout')
  return { ok: true, data: { id } }
}

export async function updateSubject(
  id: string,
  formData: FormData,
): Promise<ActionResult> {
  if (id === GENERAL_WORKSPACE_ID) {
    return { ok: false, error: 'El workspace General no se puede editar.' }
  }
  const userId = await getUserId()
  const parsed = parseSubject(formData)
  if (!parsed.ok) return { ok: false, error: parsed.error }

  const updated = await getSubjectsRepo().update(userId, id, parsed.input)
  if (!updated) return { ok: false, error: 'No encontramos la materia.' }
  revalidatePath('/', 'layout')
  return { ok: true }
}

export async function renameSubject(id: string, name: string): Promise<ActionResult> {
  if (id === GENERAL_WORKSPACE_ID) {
    return { ok: false, error: 'El workspace General no se puede renombrar.' }
  }
  const parsed = subjectSchema.shape.name.safeParse(name)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message }

  const userId = await getUserId()
  const renamed = await getSubjectsRepo().rename(userId, id, parsed.data)
  if (!renamed) return { ok: false, error: 'No encontramos la materia.' }
  revalidatePath('/', 'layout')
  return { ok: true }
}

export async function deleteSubject(id: string): Promise<ActionResult> {
  if (id === GENERAL_WORKSPACE_ID) {
    return { ok: false, error: 'El workspace General no se puede eliminar.' }
  }
  const userId = await getUserId()
  const deleted = await getSubjectsRepo().remove(userId, id)
  if (!deleted) return { ok: false, error: 'No encontramos la materia.' }
  revalidatePath('/', 'layout')
  return { ok: true }
}

const MAX_IMPORT = 50

/** Importa materias desde un texto: una por línea, con código opcional ("MAT-201 | Análisis II"). */
export async function importSubjects(
  text: string,
): Promise<ActionResult<{ count: number }>> {
  const userId = await getUserId()
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (lines.length === 0) {
    return { ok: false, error: 'Pegá al menos una materia, una por línea.' }
  }
  if (lines.length > MAX_IMPORT) {
    return { ok: false, error: `Se pueden importar hasta ${MAX_IMPORT} materias a la vez.` }
  }

  const inputs: SubjectInput[] = []
  for (const [index, line] of lines.entries()) {
    const [first, ...rest] = line.split('|').map((part) => part.trim())
    const hasCode = rest.length > 0 && rest.join('|').length > 0
    const name = hasCode ? rest.join(' | ') : first
    const code = hasCode ? first : ''
    if (name.length === 0 || name.length > 120 || code.length > 20) {
      return {
        ok: false,
        error: `La línea ${index + 1} no es válida: el nombre admite hasta 120 caracteres y el código hasta 20.`,
      }
    }
    inputs.push({
      name,
      code: code || null,
      description: null,
      color: COLOR_KEYS[index % COLOR_KEYS.length],
      icon: DEFAULT_ICON,
    })
  }

  const count = await getSubjectsRepo().createMany(userId, inputs)
  revalidatePath('/', 'layout')
  return { ok: true, data: { count } }
}
