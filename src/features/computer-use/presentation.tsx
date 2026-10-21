import React from 'react'

export const computerStateLabels: Record<string, string> = { idle: '等待任务', awaitingPermission: '等待授权', ready: '已就绪', running: '正在操作', paused: '已暂停', humanControl: '你正在接管', resuming: '正在继续', stopping: '正在停止', stopped: '已停止', faulted: '需要处理', disconnected: '连接断开', connecting: '正在连接', pausing: '正在暂停', handingOver: '正在接管' }
export interface ComputerApprovalRequest { requestId: string; requestVersion: number; sessionId: string; appId: string; appName: string; targetTitle?: string; reason: string; createdAt: number; expiresAt: number; state: 'pending'; preflight?: ComputerNativeView }
export interface NativeApplication { appId: string; name: string; running: boolean }
export interface ComputerNativeView { available?: boolean; platform?: string; permissions?: Record<string, boolean>; message?: string; mode?: 'local' | 'remote' | 'browser' }
export type SystemPermissionKind = 'screenRecording' | 'accessibility' | 'inputMonitoring'
export const computerApprovalNeedsSystemPermissions = (native: ComputerNativeView | null | undefined): boolean => native?.platform === 'darwin' && (native.permissions?.screenRecording !== true || native.permissions?.accessibility !== true || native.permissions?.postEvents === false)
export function SystemPermissionNotice({ native, busy, full = false, onOpenSettings, onRefresh }: { native: ComputerNativeView | null | undefined; busy: boolean; full?: boolean; onOpenSettings(kind: SystemPermissionKind): void; onRefresh(): void }) {
  if (native?.platform !== 'darwin') return null
  const permissions = native.permissions
  const items = ([
    ['screenRecording', '屏幕录制', '读取你授权应用的画面。', permissions?.screenRecording],
    ['accessibility', '辅助功能', '点击、输入和执行你的任务。', permissions?.accessibility === undefined ? undefined : permissions.accessibility === true && permissions.postEvents !== false],
    ['inputMonitoring', '输入监控', '检测你的手动操作并让出控制。', permissions?.inputMonitoring],
  ] as const).filter(row => full || row[3] !== true)
  if (!items.length) return null
  const remote = native.mode === 'remote'
  return <div className="qyt-computer-system-permissions" aria-label="系统权限引导">
    {!full && <p className="qyt-computer-notice" role="status">{remote ? '请在独立电脑上开启以下权限，再返回这里刷新。' : computerApprovalNeedsSystemPermissions(native) ? '先开启以下系统权限，再允许本次任务。' : '建议开启输入监控，便于在你操作时及时让出控制。'}</p>}
    <div className="qyt-computer-permission-list">{items.map(([kind, label, description, granted]) => <div className="qyt-computer-permission-row" key={kind}><div><strong>{label}</strong><span className="qyt-computer-caption">{description}</span></div><span className="qyt-computer-caption">{granted === undefined ? '待检查' : granted ? '已允许' : '未允许'}</span>{!remote && <button type="button" className="qyt-button" disabled={busy} aria-label={`前往开启${label}`} onClick={() => onOpenSettings(kind)}>前往开启权限</button>}</div>)}</div>
    {!full && <button type="button" className="qyt-button" disabled={busy} onClick={onRefresh}>刷新权限</button>}
  </div>
}
export type ComputerDecision = 'once' | 'always' | 'deny'
export function ComputerIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2.5"/><path d="M8 21h8M12 17v4M7 9h4M7 12h7"/></svg> }
export function ComputerApprovalCard({ request, busy, allowDisabled = false, onDecision }: { request: ComputerApprovalRequest; busy: boolean; allowDisabled?: boolean; onDecision(decision: ComputerDecision): void }) {
  const expired = request.expiresAt <= Date.now()
  return <section className="qyt-computer-approval" aria-label="电脑操作授权" data-qyt-computer-request={request.requestId}>
    <div className="qyt-computer-card-heading"><span className="qyt-feature-icon"><ComputerIcon/></span><div><strong>{request.appName || '应用请求授权'}</strong><span className="qyt-computer-caption">{expired ? '请求已过期' : '需要你的允许'}</span></div></div>
    {request.targetTitle && <p className="qyt-computer-request-target">{request.targetTitle}</p>}
    <p>{expired ? '请让模型重新请求本次操作。' : request.reason || '模型需要查看并操作这个应用，以完成当前聊天的任务。'}</p>
    {!expired && <><div className="qyt-computer-actions"><button type="button" className="qyt-button qyt-button-primary" disabled={busy || allowDisabled} onClick={() => onDecision('once')}>允许一次</button><button type="button" className="qyt-button" disabled={busy || allowDisabled} onClick={() => onDecision('always')}>始终允许</button><button type="button" className="qyt-button qyt-computer-button-quiet" disabled={busy} onClick={() => onDecision('deny')}>拒绝</button></div><p className="qyt-computer-caption">一次授权仅用于本次任务；持续授权可在电脑操控设置中撤销。</p></>}
  </section>
}
