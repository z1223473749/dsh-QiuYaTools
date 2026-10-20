import { gunzipSync } from 'node:zlib'

export interface ArchiveValidationOptions {
  packageName: string
  version: string
  architecture: 'arm64' | 'x64'
}

export interface ArchiveMetadata {
  packageName: string
  version: string
  unpackedBytes: number
  files: string[]
  architectures: ('arm64' | 'x64')[]
}

const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024
const MAX_ENTRIES = 10_000
const MAX_METADATA_BYTES = 1024 * 1024
const HELPER = 'package/lib/QiuYaTools Sessions.app/Contents/MacOS/qiuya-session-window'
const textDecoder = new TextDecoder('utf-8', { fatal: true })
const safePaxKeys = new Set(['path', 'size', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname', 'charset', 'comment', 'SCHILY.dev', 'SCHILY.ino', 'SCHILY.nlink'])

/** A bounded diagnostic that never includes archive paths, contents or credentials. */
function invalid(reason: string): never {
  throw new Error(`Invalid update archive: ${reason}`)
}

function utf8(bytes: Uint8Array): string {
  try { return textDecoder.decode(bytes) }
  catch { return invalid('invalid text encoding') }
}

function field(header: Buffer, offset: number, length: number): string {
  const bytes = header.subarray(offset, offset + length)
  const end = bytes.indexOf(0)
  if (end !== -1 && bytes.subarray(end).some(value => value !== 0)) invalid('invalid tar field')
  return utf8(end === -1 ? bytes : bytes.subarray(0, end))
}

function octal(header: Buffer, offset: number, length: number): number {
  const raw = header.subarray(offset, offset + length).toString('ascii').replace(/\0.*$/u, '').trim()
  if (!/^[0-7]+$/u.test(raw)) invalid('invalid tar number')
  const value = Number.parseInt(raw, 8)
  if (!Number.isSafeInteger(value)) invalid('tar number is too large')
  return value
}

function decimal(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) invalid('invalid PAX size')
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number > MAX_UNPACKED_BYTES) invalid('PAX size is too large')
  return number
}

function safePath(value: string, directory = false): string {
  if (!value || value.length > 4096 || /[\\\u0000-\u001f\u007f]/u.test(value) || value.startsWith('/')) invalid('unsafe tar path')
  const path = directory && value.endsWith('/') ? value.slice(0, -1) : value
  if (path.split('/').some(part => !part || part === '.' || part === '..') || /^[A-Za-z]:/u.test(path)) invalid('unsafe tar path')
  return path
}

/** macOS commonly extracts onto a case-insensitive, Unicode-normalizing volume. */
function pathKey(path: string): string {
  return path.normalize('NFD').toLowerCase()
}

function pax(data: Buffer): Map<string, string> {
  if (data.length > MAX_METADATA_BYTES) invalid('PAX metadata is too large')
  const result = new Map<string, string>()
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(32, offset)
    if (space < offset + 1 || space - offset > 10) invalid('invalid PAX record')
    const rawLength = data.subarray(offset, space).toString('ascii')
    if (!/^[1-9][0-9]*$/u.test(rawLength)) invalid('invalid PAX record')
    const length = Number(rawLength)
    const end = offset + length
    if (!Number.isSafeInteger(length) || end > data.length || end <= space + 2 || data[end - 1] !== 10) invalid('invalid PAX record')
    const entry = utf8(data.subarray(space + 1, end - 1))
    const equal = entry.indexOf('=')
    if (equal <= 0) invalid('invalid PAX record')
    const key = entry.slice(0, equal)
    const value = entry.slice(equal + 1)
    if (!safePaxKeys.has(key) || result.has(key) || value.includes('\0')) invalid('unsupported PAX metadata')
    result.set(key, value)
    offset = end
  }
  return result
}

type Architecture = 'arm64' | 'x64'

function cpuArchitecture(cpu: number): Architecture {
  if (cpu === 0x0100000c) return 'arm64'
  if (cpu === 0x01000007) return 'x64'
  return invalid('unsupported helper architecture')
}

/** Inspect a Mach-O header and its load-command bounds without executing it. */
function thinArchitecture(bytes: Buffer): Architecture {
  if (bytes.length < 32) invalid('invalid native helper')
  const magic = bytes.readUInt32LE(0)
  const littleEndian = magic === 0xfeedfacf
  if (!littleEndian && magic !== 0xcffaedfe) invalid('invalid native helper')
  const uint32 = (offset: number): number => littleEndian ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset)
  const architecture = cpuArchitecture(uint32(4))
  if (uint32(12) !== 2) invalid('native helper is not executable')
  const commands = uint32(16)
  const commandBytes = uint32(20)
  if (commands === 0 || commands > 4096 || commandBytes > bytes.length - 32) invalid('invalid native helper commands')
  let offset = 32
  for (let index = 0; index < commands; index++) {
    if (offset + 8 > 32 + commandBytes) invalid('invalid native helper commands')
    const size = uint32(offset + 4)
    if (size < 8 || size % 4 !== 0 || offset + size > 32 + commandBytes) invalid('invalid native helper commands')
    offset += size
  }
  if (offset !== 32 + commandBytes) invalid('invalid native helper commands')
  return architecture
}

function helperArchitectures(bytes: Buffer): Architecture[] {
  if (bytes.length < 8) invalid('invalid native helper')
  const magic = bytes.readUInt32BE(0)
  const fat64 = magic === 0xcafebabf || magic === 0xbfbafeca
  const littleEndian = magic === 0xbebafeca || magic === 0xbfbafeca
  if (magic !== 0xcafebabe && magic !== 0xbebafeca && !fat64) return [thinArchitecture(bytes)]
  const uint32 = (offset: number): number => littleEndian ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset)
  const uint64 = (offset: number): number => {
    const value = littleEndian ? bytes.readBigUInt64LE(offset) : bytes.readBigUInt64BE(offset)
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid('invalid universal helper offset')
    return Number(value)
  }
  const count = uint32(4)
  const rowSize = fat64 ? 32 : 20
  const tableEnd = 8 + count * rowSize
  if (count < 1 || count > 16 || tableEnd > bytes.length) invalid('invalid universal helper')
  const architectures: Architecture[] = []
  const ranges: { start: number; end: number }[] = []
  for (let index = 0; index < count; index++) {
    const row = 8 + index * rowSize
    const architecture = cpuArchitecture(uint32(row))
    const start = fat64 ? uint64(row + 8) : uint32(row + 8)
    const size = fat64 ? uint64(row + 16) : uint32(row + 12)
    const end = start + size
    const alignment = uint32(row + (fat64 ? 24 : 16))
    if (alignment > 31 || start % 2 ** alignment !== 0 || start < tableEnd || size < 32 || end > bytes.length || !Number.isSafeInteger(end)
      || ranges.some(range => start < range.end && end > range.start) || architectures.includes(architecture)) invalid('invalid universal helper slice')
    if (thinArchitecture(bytes.subarray(start, end)) !== architecture) invalid('universal helper architecture mismatch')
    architectures.push(architecture)
    ranges.push({ start, end })
  }
  return architectures
}

/** Validate an npm package archive entirely in memory before Host installation. */
export function validateUpdateArchive(bytes: Uint8Array, options: ArchiveValidationOptions): ArchiveMetadata {
  if (options.architecture !== 'arm64' && options.architecture !== 'x64') invalid('unsupported target architecture')
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_COMPRESSED_BYTES) invalid('compressed size exceeds the limit')
  let tar: Buffer
  try { tar = gunzipSync(bytes, { maxOutputLength: MAX_UNPACKED_BYTES }) }
  catch { return invalid('invalid gzip data or decompression limit exceeded') }
  if (tar.length % 512 !== 0) invalid('truncated tar archive')
  const files = new Map<string, { bytes: Buffer; mode: number }>()
  const fileKeys = new Set<string>()
  const entries = new Set<string>()
  const directories = new Set<string>()
  let globalPax = new Map<string, string>()
  let nextPax: Map<string, string> | undefined
  let offset = 0
  let unpackedBytes = 0
  let count = 0
  let ended = false
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(value => value === 0)) {
      if (nextPax || offset + 1024 > tar.length || tar.subarray(offset).some(value => value !== 0)) invalid('invalid tar ending')
      ended = true
      break
    }
    if (++count > MAX_ENTRIES) invalid('too many tar entries')
    let checksum = 0
    for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : header[index]!
    if (octal(header, 148, 8) !== checksum) invalid('tar checksum mismatch')
    const magic = header.subarray(257, 263).toString('ascii')
    if (magic !== 'ustar\0' && magic !== 'ustar ') invalid('unsupported tar format')
    const name = field(header, 0, 100)
    const prefix = field(header, 345, 155)
    const rawPath = prefix ? `${prefix}/${name}` : name
    const type = header[156]!
    const isDirectory = type === 53
    safePath(rawPath, isDirectory)
    const extension = type === 120 || type === 103
    if (!extension && type !== 0 && type !== 48 && !isDirectory) invalid('unsupported tar entry type')
    if (field(header, 157, 100) !== '') invalid('tar links are not allowed')
    const mode = octal(header, 100, 8)
    if ((mode & 0o6000) !== 0) invalid('unsafe tar permissions')
    const localPax = extension ? undefined : nextPax
    const effective = new Map([...globalPax, ...(localPax ?? [])])
    const size = !extension && effective.has('size') ? decimal(effective.get('size')!) : octal(header, 124, 12)
    if (size > MAX_UNPACKED_BYTES) invalid('tar entry exceeds the limit')
    const start = offset + 512
    const end = start + size
    const next = start + Math.ceil(size / 512) * 512
    if (end > tar.length || next > tar.length) invalid('truncated tar entry')
    const data = tar.subarray(start, end)
    offset = next
    if (extension) {
      if (nextPax) invalid('ambiguous PAX metadata')
      const attributes = pax(data)
      if (type === 103) {
        if (attributes.has('path') || attributes.has('size')) invalid('unsafe global PAX metadata')
        globalPax = new Map([...globalPax, ...attributes])
      } else nextPax = attributes
      continue
    }
    nextPax = undefined
    const path = safePath(effective.get('path') ?? rawPath, isDirectory)
    if (path !== 'package' && !path.startsWith('package/')) invalid('tar entry is outside the package')
    if (path === 'package' && !isDirectory) invalid('invalid package directory')
    const key = pathKey(path)
    if (entries.has(key)) invalid('duplicate tar entry')
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index++) {
      const parent = pathKey(parts.slice(0, index).join('/'))
      if (fileKeys.has(parent)) invalid('tar file conflicts with a directory')
      directories.add(parent)
    }
    if (!isDirectory && directories.has(key)) invalid('tar file conflicts with a directory')
    entries.add(key)
    if (isDirectory) {
      if (size !== 0) invalid('invalid tar directory')
      directories.add(key)
    } else {
      unpackedBytes += size
      if (unpackedBytes > MAX_UNPACKED_BYTES) invalid('unpacked size exceeds the limit')
      files.set(path, { bytes: data, mode })
      fileKeys.add(key)
    }
  }
  if (!ended) invalid('missing tar ending')
  const manifestFile = files.get('package/package.json')
  if (!manifestFile || manifestFile.bytes.length > MAX_METADATA_BYTES) invalid('missing or oversized package manifest')
  let manifest: Record<string, unknown>
  try { manifest = JSON.parse(utf8(manifestFile.bytes)) as Record<string, unknown> }
  catch { return invalid('invalid package manifest') }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.name !== options.packageName || manifest.version !== options.version) invalid('package identity mismatch')
  const dsh = manifest.dsh as Record<string, unknown> | undefined
  const bundle = dsh?.bundle as Record<string, unknown> | undefined
  const patches = typeof bundle?.patch === 'string' ? [bundle.patch] : bundle?.patch
  if (!Array.isArray(patches) || patches.length === 0 || patches.length > 16) invalid('missing bundle manifest')
  for (const patch of patches) {
    if (typeof patch !== 'string') invalid('invalid bundle patch')
    const relative = patch.startsWith('./') ? patch.slice(2) : patch
    if (!files.has(`package/${safePath(relative)}`)) invalid('missing bundle patch')
  }
  const helper = files.get(HELPER)
  if (!helper || (helper.mode & 0o111) === 0) invalid('missing executable native helper')
  const architectures = helperArchitectures(helper.bytes)
  if (!architectures.includes(options.architecture)) invalid('native helper does not support this architecture')
  return { packageName: options.packageName, version: options.version, unpackedBytes, files: [...files.keys()], architectures }
}
