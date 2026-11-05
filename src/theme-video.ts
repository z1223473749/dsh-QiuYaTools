/** Video bytes live in GitHub Releases, outside the npm/plugin package. */
export const THEME_VIDEO_CHANNEL = '/api'
export const THEME_VIDEO_METHOD = 'qiuya-tools/theme-video/get'
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
