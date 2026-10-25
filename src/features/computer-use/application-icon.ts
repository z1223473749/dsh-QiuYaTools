/** Only bounded, embedded PNG icons cross the owner application catalog. */
export function applicationIconDataUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 21870 || !value.startsWith('data:image/png;base64,')) return
  const encoded = value.slice(22)
  if (!encoded || encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) return
  let bytes: string
  try { bytes = atob(encoded) } catch { return }
  if (bytes.length < 33 || bytes.length > 16384 || bytes.slice(0, 8) !== '\x89PNG\r\n\x1a\n' || bytes.slice(8, 16) !== '\0\0\0\rIHDR') return
  const dimension = (offset: number) => bytes.charCodeAt(offset) * 16777216 + bytes.charCodeAt(offset + 1) * 65536 + bytes.charCodeAt(offset + 2) * 256 + bytes.charCodeAt(offset + 3)
  const width = dimension(16), height = dimension(20)
  if (width < 1 || height < 1 || width > 64 || height > 64) return
  return value
}
