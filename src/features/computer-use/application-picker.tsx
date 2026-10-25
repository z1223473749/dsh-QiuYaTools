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
export function ApplicationPicker({ applications, busy, onAllow, onCancel }: { applications: NativeApplication[]; busy: boolean; onAllow(appId: string): void; onCancel(): void }) {
  const [query, setQuery] = useState(''), [selectedId, setSelectedId] = useState(''), [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null), composing = useRef(false), id = useId(), listId = `${id}-applications`
  const matches = useMemo(() => { const term = searchable(query); return applications.filter(app => !term || searchable(`${app.name} ${app.appId}`).includes(term)) }, [applications, query])
  const activeIndex = Math.min(active, matches.length - 1), selected = matches.find(app => app.appId === selectedId)
  useEffect(() => { if (!busy) input.current?.focus() }, [busy])
  useEffect(() => { list.current?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' }) }, [activeIndex, query])
  const search = (value: string) => { setQuery(value); setSelectedId(''); setActive(0) }
  return <form className="qyt-computer-add-application" aria-label="添加持续授权应用" onSubmit={event => { event.preventDefault(); if (!busy && !composing.current && selected) onAllow(selected.appId) }}>
    <div className="qyt-application-picker-heading"><label htmlFor={`${id}-search`}>选择应用</label><span className="qyt-computer-caption">{query ? `${matches.length} 个结果` : `${applications.length} 个应用`}</span></div>
    <div className="qyt-application-search">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg>
      <input ref={input} id={`${id}-search`} role="combobox" aria-label="搜索应用" aria-autocomplete="list" aria-expanded="true" aria-controls={listId} aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined} value={query} disabled={busy} placeholder="搜索应用名称…" autoComplete="off" spellCheck={false} onChange={event => search(event.target.value)} onCompositionStart={() => { composing.current = true; setSelectedId('') }} onCompositionEnd={() => { composing.current = false }} onKeyDown={event => {
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive(index => matches.length ? (Math.min(index, matches.length - 1) + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length : 0) }
        if (event.key === 'Home' || event.key === 'End') { if (event.ctrlKey || event.metaKey) { event.preventDefault(); setActive(event.key === 'Home' ? 0 : Math.max(0, matches.length - 1)) } }
        if (event.key === 'Enter') { event.preventDefault(); if (matches[activeIndex]) setSelectedId(matches[activeIndex].appId) }
        if (event.key === 'Escape') { event.preventDefault(); onCancel() }
      }}/>
      {query && <button type="button" disabled={busy} aria-label="清除搜索" onClick={() => { search(''); input.current?.focus() }}>×</button>}
    </div>
    <div ref={list} id={listId} role="listbox" aria-label="应用搜索结果" aria-busy={busy} className="qyt-application-list">
      {matches.map((app, index) => <button key={app.appId} id={`${listId}-${index}`} type="button" role="option" aria-selected={app.appId === selectedId} tabIndex={-1} disabled={busy} data-active={index === activeIndex} className="qyt-application-option" title={app.name} onMouseMove={() => setActive(index)} onClick={() => { setSelectedId(app.appId); setActive(index); input.current?.focus() }}>
        <ApplicationIcon application={app}/><span className="qyt-application-name">{app.name}</span>{app.running && <span className="qyt-application-running">运行中</span>}<span className="qyt-application-check" aria-hidden="true">{app.appId === selectedId ? '✓' : ''}</span>
      </button>)}
    </div>
    {!matches.length && <p className="qyt-application-no-results" role="status">{applications.length ? '未找到匹配的应用，试试其他名称。' : '暂无可添加的应用。请先打开需要操作的应用，再重新添加。'}</p>}
    <div className="qyt-application-picker-footer"><span className="qyt-computer-caption" title={selected?.name}>{selected ? `已选择 ${selected.name}` : '选择需要持续授权的应用'}</span><button type="button" className="qyt-button" disabled={busy} onClick={onCancel}>取消</button><button type="submit" className="qyt-button qyt-button-primary" disabled={busy || !selected}>始终允许</button></div>
  </form>
}
