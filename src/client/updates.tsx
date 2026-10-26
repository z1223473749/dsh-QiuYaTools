import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { PROJECT_RELEASES } from '../project.ts'
import { UPDATES_INSTALL_ENDPOINT, type UpdateInstallResult } from '../updates/contract.ts'
import { getUpdateNotice, requestUpdate } from './update-notice.ts'
import { ProjectIcon as AboutIcon } from './project-icon.tsx'
import css from './updates.css'

export function UpdatePanel({ version, ctx, automatic }: { version: string; ctx: Context; automatic?: { enabled: boolean; disabled: boolean; label?: string; hint?: string; onChange(value: boolean): void } }) {
  const updates = getUpdateNotice(ctx)
  const notice = useSyncExternalStore(updates.subscribe, updates.getSnapshot, updates.getSnapshot)
  const check = notice.result
  const [busy, setBusy] = useState<'check' | 'install' | null>(null)
  const [install, setInstall] = useState<UpdateInstallResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const live = useRef(true)
  const pending = useRef(false)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])

  async function checkUpdates(): Promise<void> {
    if (pending.current) return
    pending.current = true; setBusy('check'); setError(null)
    try {
      await updates.check(true)
      if (live.current) setInstall(null)
    }
    finally { pending.current = false; if (live.current) setBusy(null) }
  }

  async function installUpdate(): Promise<void> {
    if (pending.current || !check?.canInstall || check.status !== 'available' || !check.release) return
    pending.current = true; setBusy('install'); setError(null)
    try {
      const result = await requestUpdate<UpdateInstallResult>(ctx, UPDATES_INSTALL_ENDPOINT, { version: check.release.version })
      updates.recordInstall(result)
      if (live.current) setInstall(result)
    } catch { if (live.current) setError('未能取得更新结果。请在插件页面核对版本，再重试。') }
    finally { pending.current = false; if (live.current) setBusy(null) }
  }

  const completed = install?.status === 'restart-required' || install?.status === 'installed' || !!check?.pendingVersion
  const message = busy === 'check' || notice.checking ? '正在检查 GitHub 最新正式版…'
    : busy === 'install' ? '正在下载并安装，请稍候…'
      : install?.status === 'restart-required' ? `v${install.version} 已安装，完全退出并重新打开 Harness 后生效。`
        : install?.status === 'installed' ? `已更新至 v${install.version}。`
          : install?.status === 'already-current' ? '当前已是最新版本。'
            : install?.status === 'failed' ? install.problem?.message ?? '更新未完成，请重试。'
              : check?.pendingVersion ? `v${check.pendingVersion} 已安装，完全退出并重新打开 Harness 后生效。`
              : error ?? notice.error ?? check?.problem?.message
                ?? (check?.status === 'available' ? `发现新版本 v${check.release?.version}`
                  : check?.status === 'up-to-date' ? '当前已是最新正式版。'
                    : check?.status === 'no-release' ? 'GitHub 暂无正式发布版本。'
                      : check?.status === 'not-configured' ? '开源仓库地址尚未配置。'
                        : '从 GitHub 获取正式发布版本，按需安装更新。')
  const failed = !!error || !!notice.error || check?.status === 'error' || install?.status === 'failed'

  return <div className="qyt-updates">
    <style>{css}</style>
    <div className="qyt-updates-intro"><span><AboutIcon kind="update"/></span><div><h3>版本更新</h3><p>从 GitHub 获取工具箱的最新正式版。</p></div></div>
    {automatic && <div className="qyt-about-auto-check"><span><strong>{automatic.label ?? '自动检查更新'}</strong><small>{automatic.hint ?? '启动后在后台检查，每天一次；发现新版本时显示提醒，由你选择安装。'}</small></span><Switch className="qyt-switch" checked={automatic.enabled} disabled={automatic.disabled} label={automatic.label ?? '自动检查更新'} onChange={automatic.onChange}/></div>}
    <section className="qyt-about-update" aria-label="插件更新" aria-busy={busy !== null}>
      <div className="qyt-about-update-title"><span><span className="qyt-about-update-icon"><AboutIcon kind="update"/></span><h4>版本与更新</h4></span><span className="qyt-about-current">当前 v{version}</span></div>
      <p className="qyt-about-update-message" data-state={failed ? 'error' : completed ? 'complete' : busy ? 'busy' : 'idle'} role={failed ? 'alert' : 'status'}>{message}</p>
      {check?.status === 'available' && check.release && !completed && <div className="qyt-about-release"><span>v{check.release.version}</span>{check.release.title && <strong>{check.release.title}</strong>}{check.release.notes && <p>{check.release.notes}</p>}</div>}
      <div className="qyt-about-update-actions">
        <button className="qyt-button qyt-about-check" type="button" disabled={busy !== null || completed} onClick={() => { void checkUpdates() }}>{busy === 'check' ? '正在检查…' : '检查更新'}</button>
        {check?.status === 'available' && check.canInstall && !completed && <button className="qyt-button qyt-button-primary qyt-about-install" type="button" disabled={busy !== null} onClick={() => { void installUpdate() }}>{busy === 'install' ? '正在更新…' : `更新至 v${check.release?.version}`}</button>}
        {PROJECT_RELEASES && <a href={PROJECT_RELEASES} target="_blank" rel="noopener noreferrer">发布记录 <AboutIcon kind="arrow"/></a>}
      </div>
      <p className="qyt-about-update-hint">更新后重新打开 Harness 即可生效，原有功能设置和会话会保留。</p>
    </section>
    <div className="qyt-updates-steps" aria-label="更新步骤"><span><b>1</b>检查新版</span><i aria-hidden="true">→</i><span><b>2</b>安装更新</span><i aria-hidden="true">→</i><span><b>3</b>重新打开</span></div>
  </div>
}
