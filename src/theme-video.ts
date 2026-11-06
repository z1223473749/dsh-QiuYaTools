/** Video bytes live in GitHub Releases, outside the npm/plugin package. */
export const THEME_VIDEO_CHANNEL = '/api'
export const THEME_VIDEO_METHOD = 'qiuya-tools/theme-video/get'
export const LOCAL_THEME_VIDEO_METHOD = 'qiuya-tools/theme-video/local'
export const LOCAL_THEME_VIDEO_UPLOAD = 'qiuya-tools/theme-video/upload'
export const LOCAL_VIDEO_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
export const THEME_SOUND_EVENT = 'qyt-theme-video-sound'

/** Read only box headers and track types. Skip the media payload, even for multi-GB files. */
export async function readMp4Tracks(
  length: number, read: (offset: number, count: number) => Promise<Uint8Array>,
): Promise<{ video: boolean; audio: boolean }> {
  const result = { video: false, audio: false }
  let branded = false, movie = false
  async function boxes(start: number, end: number, parents = ''): Promise<void> {
    for (let offset = start; offset + 8 <= end;) {
      const bytes = await read(offset, Math.min(16, end - offset))
      if (bytes.length < 8) break
      const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      let size = data.getUint32(0), header = 8
      const type = String.fromCharCode(...bytes.subarray(4, 8))
      if (size === 1) {
        if (bytes.length < 16) break
        size = Number(data.getBigUint64(8))
        header = 16
      } else if (size === 0) size = end - offset
      if (!Number.isSafeInteger(size) || size < header || size > end - offset) break
      const body = offset + header, next = offset + size
      if (!parents && type === 'ftyp' && next - body >= 8) branded = true
      if ((!parents && type === 'moov') || (parents === 'moov' && type === 'trak') || (parents === 'moovtrak' && type === 'mdia')) {
        await boxes(body, next, parents + type)
        if (!parents) movie = true
      }
      if (parents === 'moovtrakmdia' && type === 'hdlr' && next - body >= 12) {
        const handler = await read(body + 8, 4)
        const code = String.fromCharCode(...handler)
        if (code === 'vide') result.video = true
        if (code === 'soun') result.audio = true
      }
      if (!parents && branded && movie) break
      offset = next
    }
  }
  await boxes(0, length)
  return branded ? result : { video: false, audio: false }
}
export const THEME_VIDEOS = {
  fox: {
    url: 'https://github.com/z1223473749/dsh-QiuYaTools/releases/download/v0.7.3/q-theme-fox-8d971cdb.mp4',
    sha256: '8d971cdb9b04f9b4a4c2ec8f5d0a8905b67c97737766f5516e3e3bd8274e9acb',
    bytes: 5_974_916,
  },
  garo: {
    url: 'https://github.com/z1223473749/dsh-QiuYaTools/releases/download/v0.7.4/q-theme-garo-9eaf4498.mp4',
    sha256: '9eaf4498b68ebcbf6904075d78734bd6f73df78eb61485fa4d3eb59f306a083d',
    bytes: 14_243_693,
  },
} as const
