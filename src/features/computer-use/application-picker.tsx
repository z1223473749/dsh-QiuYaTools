import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { NativeApplication } from './contract.ts'
import { applicationIconDataUrl } from './application-icon.ts'

export function ApplicationIcon({ application }: { application?: NativeApplication }) {
  const [failedSource, setFailedSource] = useState<string>()
  const source = applicationIconDataUrl(application?.iconDataUrl)
  return <span className="qyt-application-icon" aria-hidden="true">
    {source && source !== failedSource ? <img src={source} alt="" draggable={false} onError={() => setFailedSource(source)}/> : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M9 4v16M4 9h16"/></svg>}
  </span>
}

const searchable = (text: string) => text.normalize('NFKC').toLocaleLowerCase().trim()
export function ApplicationPicker({ applications, busy, allowDisabled = false, onAllow, onCancel }: { applications: NativeApplication[]; busy: boolean; allowDisabled?: boolean; onAllow(appIds: string[]): void; onCancel(): void }) {
  const [query, setQuery] = useState(''), [ids, setIds] = useState<string[]>([]), [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null), composing = useRef(false), id = useId(), listId = `${id}-applications`
  const matches = useMemo(() => { const term = searchable(query); return applications.filter(app => !term || searchable(`${app.name} ${app.appId}`).includes(term)) }, [applications, query])
  const activeIndex = Math.min(active, matches.length - 1)
  const selectedIds = ids.filter(id => applications.some(app => app.appId === id))
  const selected = new Set(selectedIds), allSelected = matches.length > 0 && matches.every(app => selected.has(app.appId))
  // Forget grants removed from the candidates, including grants made in another
  // settings window. A later revocation must not silently select them again.
  useEffect(() => { setIds(previous => { const next = previous.filter(id => applications.some(app => app.appId === id)); return next.length === previous.length ? previous : next }) }, [applications])
  useEffect(() => { if (!busy) input.current?.focus() }, [busy])
  useEffect(() => { list.current?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' }) }, [activeIndex, query])
  const search = (value: string) => { setQuery(value); setActive(0) }
  const toggle = (appId: string) => { if (!busy) setIds(previous => previous.includes(appId) ? previous.filter(id => id !== appId) : [...previous, appId]) }
  return <form className="qyt-computer-add-application" aria-label="添加持续授权应用" onSubmit={event => { event.preventDefault(); if (!busy && !allowDisabled && !composing.current && selectedIds.length) onAllow(selectedIds) }}>
    <div className="qyt-application-picker-heading"><label htmlFor={`${id}-search`}>选择应用</label><span className="qyt-computer-caption">{query ? `${matches.length} 个结果` : `${applications.length} 个应用`}</span></div>
    <div className="qyt-application-search">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg>
      <input ref={input} id={`${id}-search`} role="combobox" aria-label="搜索应用" aria-autocomplete="list" aria-expanded="true" aria-controls={listId} aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined} value={query} disabled={busy} placeholder="搜索应用名称…" autoComplete="off" spellCheck={false} onChange={event => search(event.target.value)} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onKeyDown={event => {
        if (busy) return
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive(index => matches.length ? (Math.min(index, matches.length - 1) + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length : 0) }
        if (event.key === 'Home' || event.key === 'End') { if (event.ctrlKey || event.metaKey) { event.preventDefault(); setActive(event.key === 'Home' ? 0 : Math.max(0, matches.length - 1)) } }
        if (event.key === 'Enter') { event.preventDefault(); if (matches[activeIndex]) toggle(matches[activeIndex].appId) }
        if (event.key === 'Escape') { event.preventDefault(); onCancel() }
      }}/>
      {query && <button type="button" disabled={busy} aria-label="清除搜索" onClick={() => { search(''); input.current?.focus() }}>×</button>}
    </div>
    <div className="qyt-application-picker-selection"><span className="qyt-computer-caption">可跨搜索保留选择；全选仅作用于当前结果。</span><button type="button" className="qyt-button" disabled={busy || !matches.length} onClick={() => setIds(previous => allSelected ? previous.filter(id => !matches.some(app => app.appId === id)) : [...new Set([...previous, ...matches.map(app => app.appId)])])}>{allSelected ? '取消全选' : '全选'}</button></div>
    <div ref={list} id={listId} role="listbox" aria-label="应用搜索结果" aria-multiselectable="true" aria-busy={busy} className="qyt-application-list">
      {matches.map((app, index) => <button key={app.appId} id={`${listId}-${index}`} type="button" role="option" aria-selected={selected.has(app.appId)} tabIndex={-1} disabled={busy} data-active={index === activeIndex} className="qyt-application-option" title={app.name} onMouseMove={() => setActive(index)} onClick={() => { toggle(app.appId); setActive(index); input.current?.focus() }}>
        <ApplicationIcon application={app}/><span className="qyt-application-name">{app.name}</span>{app.running && <span className="qyt-application-running">运行中</span>}<span className="qyt-application-check" aria-hidden="true">{selected.has(app.appId) ? '✓' : ''}</span>
      </button>)}
    </div>
    {!matches.length && <p className="qyt-application-no-results" role="status">{applications.length ? '未找到匹配的应用，试试其他名称。' : '暂无未授权的应用。已授权的应用不会重复显示。'}</p>}
    <div className="qyt-application-picker-footer"><span className="qyt-computer-caption" role="status">已选择 {selectedIds.length} 个应用</span><button type="button" className="qyt-button" disabled={busy} onClick={onCancel}>取消</button><button type="submit" className="qyt-button qyt-button-primary" disabled={busy || allowDisabled || !selectedIds.length}>始终允许</button></div>
  </form>
}
