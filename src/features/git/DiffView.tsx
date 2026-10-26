import React, { useEffect, useMemo, useRef, useState } from 'react'
import { languageForPath, useCodeHighlighter, type HighlightSpan } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitClientAPI } from './client-api.ts'
import type { GitDiff, GitFile, GitSnapshot } from './contract.ts'

export const gitFileId = (path: string) => `qyt-git-file-${encodeURIComponent(path)}`
export function GitCounts({ added, deleted }: { added: number | null; deleted: number | null }) { return <span className="qyt-git-counts"><span className="qyt-git-added">{added === null ? '—' : `+${added}`}</span><span className="qyt-git-deleted">{deleted === null ? '—' : `-${deleted}`}</span></span> }
interface DiffLine { oldLine?: number; newLine?: number; text: string; kind: 'context' | 'added' | 'deleted' }
interface DiffPart { lines?: DiffLine[]; gap?: { oldStart: number; newStart: number; count: number }; key: number }
function parts(diff: GitDiff): DiffPart[] {
  const result: DiffPart[] = []; let oldNext = 1, newNext = 1, key = 0
  for (const hunk of diff.hunks) {
    const gap = Math.min(Math.max(0, hunk.oldStart - oldNext), Math.max(0, hunk.newStart - newNext))
    if (gap) result.push({ key: key++, gap: { oldStart: oldNext, newStart: newNext, count: gap } })
    let oldLine = hunk.oldStart, newLine = hunk.newStart
    const lines: DiffLine[] = []
    for (const value of hunk.lines) {
      if (value.startsWith('\\')) continue
      if (value.startsWith('+')) lines.push({ newLine: newLine++, text: value.slice(1), kind: 'added' })
      else if (value.startsWith('-')) lines.push({ oldLine: oldLine++, text: value.slice(1), kind: 'deleted' })
      else if (value.startsWith(' ')) lines.push({ oldLine: oldLine++, newLine: newLine++, text: value.slice(1), kind: 'context' })
    }
    result.push({ key: key++, lines }); oldNext = oldLine; newNext = newLine
  }
  const oldLength = (diff.oldText ?? '').split('\n').length - ((diff.oldText ?? '').endsWith('\n') ? 1 : 0), newLength = (diff.newText ?? '').split('\n').length - ((diff.newText ?? '').endsWith('\n') ? 1 : 0)
  const tail = Math.min(oldLength - oldNext + 1, newLength - newNext + 1)
  if (tail > 0 && diff.hunks.length) result.push({ key: key++, gap: { oldStart: oldNext, newStart: newNext, count: tail } })
  return result
}
function Syntax({ tokens, text }: { tokens?: HighlightSpan[]; text: string }) { return <code>{tokens ? tokens.map((token, index) => <span key={index} style={token.style}>{token.text}</span>) : text || ' '}</code> }
function SplitLines({ lines, oldTokens, newTokens }: { lines: DiffLine[]; oldTokens?: HighlightSpan[][]; newTokens?: HighlightSpan[][] }) {
  const rows: { old?: DiffLine; next?: DiffLine }[] = []
  for (let index = 0; index < lines.length;) {
    if (lines[index]!.kind === 'context') { rows.push({ old: lines[index], next: lines[index] }); index++; continue }
    const before: DiffLine[] = [], after: DiffLine[] = []
    while (index < lines.length && lines[index]!.kind !== 'context') { const line = lines[index++]!; (line.kind === 'deleted' ? before : after).push(line) }
    for (let at = 0; at < Math.max(before.length, after.length); at++) rows.push({ old: before[at], next: after[at] })
  }
  return <>{rows.map((row, index) => <tr key={index}><td className={`qyt-git-line-number ${row.old?.kind ?? 'empty'}`}>{row.old?.oldLine}</td><td className={`qyt-git-code-cell ${row.old?.kind ?? 'empty'}`}><Syntax text={row.old?.text ?? ''} tokens={row.old?.oldLine ? oldTokens?.[row.old.oldLine - 1] : undefined}/></td><td className={`qyt-git-line-number ${row.next?.kind ?? 'empty'}`}>{row.next?.newLine}</td><td className={`qyt-git-code-cell ${row.next?.kind ?? 'empty'}`}><Syntax text={row.next?.text ?? ''} tokens={row.next?.newLine ? newTokens?.[row.next.newLine - 1] : undefined}/></td></tr>)}</>
}
function UnifiedLines({ lines, oldTokens, newTokens }: { lines: DiffLine[]; oldTokens?: HighlightSpan[][]; newTokens?: HighlightSpan[][] }) { return <>{lines.map((line, index) => <tr key={index}><td className={`qyt-git-line-number ${line.kind}`}>{line.oldLine}</td><td className={`qyt-git-line-number ${line.kind}`}>{line.newLine}</td><td className={`qyt-git-marker ${line.kind}`}>{line.kind === 'added' ? '+' : line.kind === 'deleted' ? '−' : ' '}</td><td className={`qyt-git-code-cell ${line.kind}`}><Syntax text={line.text} tokens={line.kind === 'deleted' && line.oldLine ? oldTokens?.[line.oldLine - 1] : line.newLine ? newTokens?.[line.newLine - 1] : undefined}/></td></tr>)}</> }
function DiffBody({ diff, split, zh }: { diff: GitDiff; split: boolean; zh: boolean }) {
  const highlighter = useCodeHighlighter(languageForPath(diff.file.path)), [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())
  const oldTokens = useMemo(() => highlighter(diff.oldText ?? ''), [highlighter, diff.oldText]), newTokens = useMemo(() => highlighter(diff.newText ?? ''), [highlighter, diff.newText])
  const rows = useMemo(() => parts(diff), [diff]), oldLines = useMemo(() => (diff.oldText ?? '').split('\n'), [diff.oldText])
  if (diff.tooLarge || diff.file.binary) return <p className="qyt-git-note">{diff.message || (diff.file.binary ? zh ? '二进制文件已更改。' : 'Binary file changed.' : zh ? '此文件过大，无法在此展开对比。' : 'This file is too large to display here.')}</p>
  if (diff.file.kind === 'submodule' || diff.hunks.length === 0) {
    const message = diff.file.kind === 'submodule' ? zh ? '子模块版本或工作目录状态已更改。' : 'Submodule revision or working directory changed.'
      : diff.file.status === 'renamed' ? zh ? '文件已重命名，文本内容没有变化。' : 'File renamed without text changes.'
      : ['added', 'untracked'].includes(diff.file.status) ? zh ? '新增空文件。' : 'New empty file.'
      : diff.file.status === 'deleted' ? zh ? '已删除空文件。' : 'Empty file deleted.'
      : zh ? '文件属性已更改，没有文本行差异。' : 'File metadata changed without text differences.'
    return <><p className="qyt-git-note">{diff.message || message}</p>{diff.patch && <pre className="qyt-git-metadata" style={{ margin: '0 10px 10px', padding: 8, overflow: 'auto', fontSize: 11 }}><code>{diff.patch}</code></pre>}</>
  }
  return <div className="qyt-git-diff-scroll"><table className="qyt-git-diff-table" data-layout={split ? 'split' : 'unified'}><tbody>{rows.map(part => {
    if (part.gap && !expanded.has(part.key)) return <tr key={part.key} className="qyt-git-gap"><td colSpan={4}><button type="button" onClick={() => setExpanded(value => new Set([...value, part.key]))}>{zh ? `展开 ${part.gap.count} 行未修改内容` : `Expand ${part.gap.count} unchanged lines`}</button></td></tr>
    const lines = part.lines ?? Array.from({ length: part.gap!.count }, (_, index): DiffLine => ({ oldLine: part.gap!.oldStart + index, newLine: part.gap!.newStart + index, text: oldLines[part.gap!.oldStart + index - 1] ?? '', kind: 'context' }))
    return split ? <SplitLines key={part.key} lines={lines} oldTokens={oldTokens} newTokens={newTokens}/> : <UnifiedLines key={part.key} lines={lines} oldTokens={oldTokens} newTokens={newTokens}/>
  })}</tbody></table></div>
}
export function GitFileDiff({ file, snapshot, api, split, selected, zh, onStage }: { file: GitFile; snapshot: GitSnapshot; api: GitClientAPI; split: boolean; selected: boolean; zh: boolean; onStage?: (file: GitFile) => void }) {
  const root = useRef<HTMLElement>(null), focused = useRef(false), [visible, setVisible] = useState(selected), [data, setData] = useState<{ diff?: GitDiff; error?: string }>({})
  const unstage = snapshot.scope === 'staged' || snapshot.scope !== 'unstaged' && file.staged && !file.unstaged
  // A newly opened file initially has only a loading placeholder. Position it
  // after the real diff has laid out, once per explicit selection.
  useEffect(() => { if (!selected) { focused.current = false; return } if (data.diff && !focused.current) { root.current?.scrollIntoView?.({ block: 'start' }); focused.current = true } }, [selected, data.diff])
  useEffect(() => { if (selected) setVisible(true) }, [selected])
  useEffect(() => { if (visible) return; const element = root.current, Observer = element?.ownerDocument.defaultView?.IntersectionObserver; if (!element || !Observer) { setVisible(true); return } const observer = new Observer(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect() } }, { rootMargin: '700px' }); observer.observe(element); return () => observer.disconnect() }, [visible])
  useEffect(() => {
    if (!visible) return
    const controller = new AbortController(); let active = true; setData({})
    void api.diff({ op: 'diff', sessionId: snapshot.sessionId, path: file.path, scope: snapshot.scope, ...(snapshot.target ? { target: snapshot.target } : {}), expectedRevision: snapshot.revision }, controller.signal).then(diff => { if (active && !controller.signal.aborted) setData({ diff }) }).catch(error => { if (active && !controller.signal.aborted) setData({ error: error instanceof Error ? error.message : 'Git diff unavailable.' }) })
    return () => { active = false; controller.abort() }
  }, [api, snapshot.sessionId, snapshot.revision, snapshot.scope, snapshot.target, file.path, visible])
  return <section ref={root} className="qyt-git-file-diff" id={gitFileId(file.path)} data-selected={selected} data-git-path={file.path}>
    <header><span className="qyt-git-file-path" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>{file.oldPath ? `${file.oldPath} → ` : ''}{file.path}</span><GitCounts added={file.added} deleted={file.deleted}/>{onStage && <button type="button" className="qyt-git-icon-button" onClick={() => onStage(file)} title={unstage ? zh ? '取消暂存' : 'Unstage' : zh ? '暂存文件' : 'Stage file'}>{unstage ? '−' : '+'}</button>}</header>
    {data.error ? <p className="qyt-git-error" role="alert">{data.error}</p> : data.diff ? <DiffBody diff={data.diff} split={split} zh={zh}/> : <p className="qyt-git-note">{zh ? '正在读取文件对比…' : 'Loading file differences…'}</p>}
  </section>
}
