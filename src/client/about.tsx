import React, { useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { PROJECT_REPOSITORY, PROJECT_ISSUES, PROJECT_RELEASES } from '../project.ts'
import { UPDATES_CHANNEL, UPDATES_CHECK_ENDPOINT, UPDATES_INSTALL_ENDPOINT, type UpdateCheckResult, type UpdateInstallResult } from '../updates/contract.ts'
import { COLOR_ICON_DATA_URL } from './brand-assets.ts'
import css from './about.css'

interface RpcClient {
  rpc: { call(channel: string, endpoint: string, payload: unknown): Promise<{ ok: true; value: unknown } | { ok: false; error: { message: string } }> }
}

function AboutIcon({ kind }: { kind: 'github' | 'update' | 'arrow' | 'heart' }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'github' ? <><path d="M9 19c-4.3 1.3-4.3-2.2-6-2.6m12 5v-3.4a3 3 0 0 0-.8-2.3c2.7-.3 5.5-1.3 5.5-6A4.6 4.6 0 0 0 18.4 6a4.3 4.3 0 0 0-.1-3.3S17.2 2.3 15 4a11.7 11.7 0 0 0-6 0C6.8 2.3 5.7 2.7 5.7 2.7A4.3 4.3 0 0 0 5.6 6a4.6 4.6 0 0 0-1.3 3.2c0 4.7 2.8 5.7 5.5 6a3 3 0 0 0-.8 2.3v3.9" /></>
      : kind === 'update' ? <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 11.5-1.5L20 8M4 16l2.5 2.5A7 7 0 0 0 18 17"/></>
        : kind === 'heart' ? <path d="m12 20-7.3-7.3a4.7 4.7 0 0 1 6.6-6.6l.7.7.7-.7a4.7 4.7 0 0 1 6.6 6.6Z"/>
          : <path d="M7 17 17 7M7 7h10v10"/>}
  </svg>
}

export function AboutPanel({ version, ctx }: { version: string; ctx: Context }) {
  const [check, setCheck] = useState<UpdateCheckResult | null>(null)
  const [busy, setBusy] = useState<'check' | 'install' | null>(null)
  const [install, setInstall] = useState<UpdateInstallResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const live = useRef(true)
  const pending = useRef(false)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])

  async function request<T>(endpoint: string, payload: unknown): Promise<T> {
    const service = typeof ctx?.get === 'function' ? ctx.get('connection') : (ctx as unknown as { connection?: RpcClient })?.connection
    const connection = service as RpcClient | undefined
    if (!connection?.rpc) throw new Error('unavailable')
    const result = await connection.rpc.call(UPDATES_CHANNEL, endpoint, payload)
    if (!result.ok) throw new Error('unavailable')
    return result.value as T
  }

  async function checkUpdates(): Promise<void> {
    if (pending.current) return
    pending.current = true; setBusy('check'); setError(null)
    try {
      const result = await request<UpdateCheckResult>(UPDATES_CHECK_ENDPOINT, { force: true })
      if (live.current) { setCheck(result); setInstall(null) }
    } catch { if (live.current) setError('更新服务暂时无法连接，请重新打开 Harness 后重试。') }
    finally { pending.current = false; if (live.current) setBusy(null) }
  }

  async function installUpdate(): Promise<void> {
    if (pending.current || !check?.canInstall || check.status !== 'available' || !check.release) return
    pending.current = true; setBusy('install'); setError(null)
    try {
      const result = await request<UpdateInstallResult>(UPDATES_INSTALL_ENDPOINT, { version: check.release.version })
      if (live.current) setInstall(result)
    } catch { if (live.current) setError('未能取得更新结果。请在插件页面核对版本，再重试。') }
    finally { pending.current = false; if (live.current) setBusy(null) }
  }

  const completed = install?.status === 'restart-required' || install?.status === 'installed' || !!check?.pendingVersion
  const message = busy === 'check' ? '正在检查 GitHub 最新正式版…'
    : busy === 'install' ? '正在下载并安装，请稍候…'
      : install?.status === 'restart-required' ? `v${install.version} 已安装，完全退出并重新打开 Harness 后生效。`
        : install?.status === 'installed' ? `已更新至 v${install.version}。`
          : install?.status === 'already-current' ? '当前已是最新版本。'
            : install?.status === 'failed' ? install.problem?.message ?? '更新未完成，请重试。'
              : check?.pendingVersion ? `v${check.pendingVersion} 已安装，完全退出并重新打开 Harness 后生效。`
              : error ?? check?.problem?.message
                ?? (check?.status === 'available' ? `发现新版本 v${check.release?.version}`
                  : check?.status === 'up-to-date' ? '当前已是最新正式版。'
                    : check?.status === 'no-release' ? 'GitHub 暂无正式发布版本。'
                      : check?.status === 'not-configured' ? '开源仓库地址尚未配置。'
                        : '从 GitHub 获取正式发布版本，按需安装更新。')
  const failed = !!error || check?.status === 'error' || install?.status === 'failed'

  return <div className="qyt-about">
    <style>{css}</style>
    <header className="qyt-about-hero">
      <div className="qyt-about-sky" aria-hidden="true"><span className="qyt-about-spark qyt-about-spark-one"/><span className="qyt-about-spark qyt-about-spark-two"/><span className="qyt-about-dot"/></div>
      <div className="qyt-about-art"><span className="qyt-about-halo" aria-hidden="true"/><img src={COLOR_ICON_DATA_URL} width="108" height="108" alt="白发少年坐在鲸鱼上" /></div>
      <div className="qyt-about-copy"><span className="qyt-about-eyebrow">QiuYa 增强工具箱</span><h3 className="qyt-about-title">QiuYaTools<span aria-hidden="true">.</span></h3><p className="qyt-about-tagline">给 Harness 加一点顺手的小功能。</p></div>
      <div className="qyt-about-sea" aria-hidden="true"/>
    </header>
    <nav className="qyt-about-links" aria-label="项目与反馈">
      {PROJECT_REPOSITORY && <a className="qyt-about-link" href={PROJECT_REPOSITORY} target="_blank" rel="noopener noreferrer"><span className="qyt-about-link-icon"><AboutIcon kind="github"/></span><span className="qyt-about-link-copy"><strong>GitHub 开源</strong><small>看看源码，一起完善</small></span><AboutIcon kind="arrow"/></a>}
      {PROJECT_ISSUES && <a className="qyt-about-link" href={PROJECT_ISSUES} target="_blank" rel="noopener noreferrer"><span className="qyt-about-link-icon"><AboutIcon kind="heart"/></span><span className="qyt-about-link-copy"><strong>反馈与建议</strong><small>聊聊你的新想法</small></span><AboutIcon kind="arrow"/></a>}
    </nav>
    <section className="qyt-about-update" aria-label="插件更新" aria-busy={busy !== null}>
      <div className="qyt-about-update-title"><span><span className="qyt-about-update-icon"><AboutIcon kind="update"/></span><h4>版本与更新</h4></span><span className="qyt-about-current">当前 v{version}</span></div>
      <p className="qyt-about-update-message" data-state={failed ? 'error' : completed ? 'complete' : busy ? 'busy' : 'idle'} role={failed ? 'alert' : 'status'}>{message}</p>
      {check?.status === 'available' && check.release && !completed && <div className="qyt-about-release"><span>v{check.release.version}</span>{check.release.title && <strong>{check.release.title}</strong>}{check.release.notes && <p>{check.release.notes}</p>}</div>}
      <div className="qyt-about-update-actions">
        <button className="qyt-button qyt-about-check" type="button" disabled={busy !== null || completed} onClick={() => { void checkUpdates() }}>{busy === 'check' ? '正在检查…' : '检查更新'}</button>
        {check?.status === 'available' && check.canInstall && !completed && <button className="qyt-button qyt-button-primary qyt-about-install" type="button" disabled={busy !== null} onClick={() => { void installUpdate() }}>{busy === 'install' ? '正在更新…' : `更新至 v${check.release?.version}`}</button>}
        {PROJECT_RELEASES && <a href={PROJECT_RELEASES} target="_blank" rel="noopener noreferrer">发布记录 <AboutIcon kind="arrow"/></a>}
      </div>
      <p className="qyt-about-update-hint">更新后需要重新打开 Harness；设置会保留。开发链接安装会切换为发布版，源码目录仍保留。</p>
    </section>
    <footer className="qyt-about-footer"><span>Made by <strong>QiuYa</strong><span className="qyt-about-footer-dot" aria-hidden="true"/>MIT 开源</span><a href="https://www.qiuya.cc" target="_blank" rel="noopener noreferrer">www.qiuya.cc <AboutIcon kind="arrow"/></a></footer>
  </div>
}
