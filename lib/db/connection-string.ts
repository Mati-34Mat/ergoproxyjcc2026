const LEGACY_SSL_MODES = new Set(['prefer', 'require', 'verify-ca'])

/**
 * pg trata hoy `prefer`, `require` y `verify-ca` como `verify-full` y avisa que en pg v9 cambiará
 * a la semántica de libpq. Se declara `verify-full` de forma explícita para conservar el
 * comportamiento actual (el más seguro) y evitar el warning.
 */
export function normalizeConnectionString(connectionString: string | undefined) {
  if (!connectionString) return connectionString

  try {
    const url = new URL(connectionString)
    const sslmode = url.searchParams.get('sslmode')
    if (!sslmode || !LEGACY_SSL_MODES.has(sslmode) || url.searchParams.has('uselibpqcompat')) {
      return connectionString
    }
    url.searchParams.set('sslmode', 'verify-full')
    return url.toString()
  } catch {
    return connectionString
  }
}
