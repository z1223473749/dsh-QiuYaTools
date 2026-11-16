import { BufferGeometry, Float32BufferAttribute } from 'three'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'

/** Refine a closed extrusion before curving it. Neighboring triangles
 * share each split edge, so bending cannot pull a midpoint off a seam. */
export function refineProfile(source: BufferGeometry, maxEdge: number) {
  source.deleteAttribute('normal')
  source.deleteAttribute('uv')
  const welded = mergeVertices(source, .00008)
  const positions = Array.from(welded.attributes.position.array)
  let indices = Array.from(welded.index!.array)
  welded.dispose()
  const limit = maxEdge * maxEdge

  for (let pass = 0; pass < 12; pass++) {
    const midpoints = new Map<number, number>()
    const stride = positions.length / 3
    function split(a: number, b: number) {
      const ai = 3 * a, bi = 3 * b
      const dx = positions[ai] - positions[bi]
      const dy = positions[ai + 1] - positions[bi + 1]
      const dz = positions[ai + 2] - positions[bi + 2]
      if (dx * dx + dy * dy + dz * dz <= limit) return -1
      const key = Math.min(a, b) * stride + Math.max(a, b)
      const existing = midpoints.get(key)
      if (existing !== undefined) return existing
      const midpoint = positions.length / 3
      positions.push(positions[bi] + dx / 2, positions[bi + 1] + dy / 2, positions[bi + 2] + dz / 2)
      midpoints.set(key, midpoint)
      return midpoint
    }

    const refined: number[] = []
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i], b = indices[i + 1], c = indices[i + 2]
      const ab = split(a, b), bc = split(b, c), ca = split(c, a)
      const mask = (ab >= 0 ? 1 : 0) | (bc >= 0 ? 2 : 0) | (ca >= 0 ? 4 : 0)
      switch (mask) {
        case 0: refined.push(a, b, c); break
        case 1: refined.push(a, ab, c, ab, b, c); break
        case 2: refined.push(a, b, bc, a, bc, c); break
        case 3: refined.push(a, ab, c, ab, bc, c, ab, b, bc); break
        case 4: refined.push(a, b, ca, b, c, ca); break
        case 5: refined.push(a, ab, ca, ab, b, c, ab, c, ca); break
        case 6: refined.push(a, b, bc, a, bc, ca, bc, c, ca); break
        case 7: refined.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca); break
      }
    }
    if (midpoints.size === 0) break
    indices = refined
  }
  const result = new BufferGeometry()
  result.setAttribute('position', new Float32BufferAttribute(positions, 3))
  result.setIndex(indices)
  return result
}

/** Sample the actual curved triangles, including the bevel at a lock's root. */
export function profileFrontDepth(geometry: BufferGeometry) {
  const points = geometry.attributes.position, indices = geometry.index!
  const cellSize = .025
  const triangles: { a: number; b: number; c: number; area: number }[] = []
  const cells = new Map<string, number[]>()
  for (let i = 0; i < indices.count; i += 3) {
    const a = indices.getX(i), b = indices.getX(i + 1), c = indices.getX(i + 2)
    const ax = points.getX(a), ay = points.getY(a)
    const bx = points.getX(b), by = points.getY(b), cx = points.getX(c), cy = points.getY(c)
    const area = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
    if (area <= 1e-12) continue
    const triangle = triangles.push({ a, b, c, area }) - 1
    const left = Math.floor(Math.min(ax, bx, cx) / cellSize), right = Math.floor(Math.max(ax, bx, cx) / cellSize)
    const bottom = Math.floor(Math.min(ay, by, cy) / cellSize), top = Math.floor(Math.max(ay, by, cy) / cellSize)
    for (let x = left; x <= right; x++) for (let y = bottom; y <= top; y++) {
      const key = `${x},${y}`
      const list = cells.get(key)
      if (list) list.push(triangle)
      else cells.set(key, [triangle])
    }
  }
  return (x: number, y: number) => {
    const list = cells.get(`${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`)
    let front = -Infinity
    for (const index of list ?? []) {
      const { a, b, c, area } = triangles[index]
      const ax = points.getX(a), ay = points.getY(a), bx = points.getX(b), by = points.getY(b)
      const cx = points.getX(c), cy = points.getY(c)
      const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / area
      const v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / area
      const w = 1 - u - v
      if (u >= -1e-7 && v >= -1e-7 && w >= -1e-7) {
        front = Math.max(front, u * points.getZ(a) + v * points.getZ(b) + w * points.getZ(c))
      }
    }
    return Number.isFinite(front) ? front : undefined
  }
}
