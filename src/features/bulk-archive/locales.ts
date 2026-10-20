export const bulkArchiveZh = {
  selected: '已选择 {n} 条会话',
  archive: '批量归档 {n} 条会话',
  clear: '取消选择',
  pending: '正在归档 {n} 条会话…',
  done: '已归档 {n} 条会话',
  failed: '已归档 {n} 条，{failed} 条未归档。失败会话仍保持选中，可重试。',
  close: '关闭',
  workspace: '工作区归档',
  pin: '置顶会话',
  rename: '重命名',
  fork: '分叉会话',
  membershipChanged: '会话已移出此工作区，未归档',
}
export const bulkArchiveEn: typeof bulkArchiveZh = {
  selected: '{n} sessions selected',
  archive: 'Archive {n} selected sessions',
  clear: 'Clear selection',
  pending: 'Archiving {n} sessions…',
  done: 'Archived {n} sessions',
  failed: 'Archived {n}; {failed} failed. Failed sessions remain selected for retry.',
  close: 'Dismiss',
  workspace: 'Archive workspace sessions',
  pin: 'Pin session',
  rename: 'Rename',
  fork: 'Fork session',
  membershipChanged: 'Session moved out of this workspace; not archived',
}

export const BULK_ARCHIVE_NS = 'qiuyaTools.bulkArchive'
export type BulkArchiveLocaleKey = keyof typeof bulkArchiveZh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'qiuyaTools.bulkArchive': BulkArchiveLocaleKey
  }
}
