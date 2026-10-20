/** Strict SemVer ordering without lossy integer conversion or locale-dependent sorting. */
export interface SemanticVersion {
  readonly version: string
  readonly major: string
  readonly minor: string
  readonly patch: string
  readonly prerelease: readonly string[]
}

export function parseSemanticVersion(input: unknown): SemanticVersion | undefined {
  if (typeof input !== 'string' || input.length > 256 || /\s/u.test(input)) return undefined
  const value = input.startsWith('v') ? input.slice(1) : input
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value)
  if (match === null) return undefined
  const prerelease = match[4]?.split('.') ?? []
  if (prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) return undefined
  return { version: value, major: match[1]!, minor: match[2]!, patch: match[3]!, prerelease }
}

function numericOrder(left: string, right: string): number {
  return left.length === right.length ? left === right ? 0 : left < right ? -1 : 1 : left.length < right.length ? -1 : 1
}

/** Returns -1, 0 or 1; build metadata does not affect precedence. */
export function compareVersions(left: string, right: string): -1 | 0 | 1 {
  const a = parseSemanticVersion(left)
  const b = parseSemanticVersion(right)
  if (a === undefined || b === undefined) throw new Error('Invalid semantic version')
  for (const field of ['major', 'minor', 'patch'] as const) {
    const order = numericOrder(a[field], b[field])
    if (order !== 0) return order as -1 | 1
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index]
    const y = b.prerelease[index]
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1
    if (x === y) continue
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) return numericOrder(x, y) as -1 | 1
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}
