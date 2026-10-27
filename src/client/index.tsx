import { installBrowserDiagnosticClient } from '../features/browser-diagnostics/client.tsx'
import React, { useEffect, useId, useRef, useState, useMemo, useSyncExternalStore } from 'react'
import { installAcceptanceWorkflowClient } from '../features/acceptance-workflows/client.tsx'
import { installAcceptanceTemplateClient } from '../features/acceptance-templates/client.tsx'
import { installAcceptanceRunClient } from '../features/acceptance-runs/client.tsx'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import pkg from '../../package.json' with { type: 'json' }
import {
  SETTINGS_ID, DEFAULT_PREFERENCES, FEATURE_FIELDS, isFeatureEnabled, parsePasteThreshold, getQThemeId, getThemeMotion,
  type FeatureField, type Preferences, type QThemeId, type ThemeMotion,
} from '../shared.ts'
import { installFeatures } from './features.ts'
import { installAccountMenuEntry, consumeComputerSettingsNavigation, subscribeComputerSettingsNavigation, consumeUpdatesSettingsNavigation, subscribeUpdatesSettingsNavigation, openUpdatesSettings } from './account-menu.ts'
import { installSettingsNavIcon } from './settings-nav-icon.ts'
import { AboutPanel } from './about.tsx'
import { UpdatePanel } from './updates.tsx'
import { getUpdateNotice, installAutomaticUpdateChecks, disposeUpdateNotice } from './update-notice.ts'
import { ComputerPanel } from '../features/computer-use/panel.tsx'
import { installChatComputerEnvironment } from '../features/computer-use/chat-environment.tsx'
import { installWorkbenchClient } from '../features/workbench/client.tsx'
import { createWorkbenchAPI, type WorkbenchConnection } from '../features/workbench/client-api.ts'
import { SitePermissions } from '../features/workbench/Views.tsx'
import { ComputerIcon } from '../features/computer-use/presentation.tsx'
import { computerVisualStyles } from '../features/computer-use/visual-style.ts'
import { installQTheme } from './q-theme.ts'
import { Q_THEMES, getQTheme, type ThemeDefinition } from './theme-catalog.ts'
import { ThemePreview } from './theme-preview.tsx'
import { MONO_ICON_DATA_URL, OCEAN_SCENE_DATA_URL } from './brand-assets.ts'
import { installEarlySessionWindowNavigation } from '../features/session-windows/index.tsx'
import { getSessionWindowSupport } from './session-window-support.ts'
import { MINIMUM_SESSION_WINDOW_HARNESS_VERSION } from '../features/session-windows/compatibility.ts'
import { zh, en, type LocaleKey } from './locales.ts'
import css from './styles.css'

const NS = 'qiuyaTools'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    qiuyaTools: LocaleKey
  }
}

type SettingsProps = PropsRuntime<'settings.section'> & PropsLocale<typeof NS> & {
  form: ConfigForm<Preferences>
  ctx: Context
}

type ThresholdDraft = { characters: string; lines: string }
type FormOperations = Parameters<ConfigForm<Preferences>['mutate']>[0]

type SettingsTab = FeatureField | 'qTheme' | 'about' | 'updates' | 'computer'
const FEATURES: readonly { field: FeatureField; tab: LocaleKey; label: LocaleKey; hint: LocaleKey; steps: readonly LocaleKey[] }[] = [
  { field: 'pastedTextEnabled', tab: 'pastedTextTab', label: 'pastedText', hint: 'pastedTextHint', steps: [] },
  { field: 'sessionWindowsEnabled', tab: 'sessionWindowsTab', label: 'sessionWindows', hint: 'sessionWindowsHint', steps: ['sessionWindowsMenu', 'sessionWindowsDrag'] },
  { field: 'bulkArchiveEnabled', tab: 'bulkArchiveTab', label: 'bulkArchive', hint: 'bulkArchiveHint', steps: ['bulkArchiveSelect', 'bulkArchiveSelected', 'bulkArchiveWorkspace'] },
  { field: 'planCommentsEnabled', tab: 'planCommentsTab', label: 'planComments', hint: 'planCommentsHint', steps: ['planCommentsSelection', 'planCommentsCard', 'planCommentsSubmit'] },
  { field: 'conversationCommentsEnabled', tab: 'planCommentsTab', label: 'conversationComments', hint: 'conversationCommentsHint', steps: ['conversationCommentsSelection', 'conversationCommentsMarkers', 'conversationCommentsSubmit'] },
  { field: 'sidebarToolsEnabled', tab: 'sidebarToolsTab', label: 'sidebarTools', hint: 'sidebarToolsHint', steps: ['sidebarToolsPin', 'sidebarToolsUnread', 'sidebarToolsCopy', 'sidebarToolsWorkspace'] },
  { field: 'promptSuggestionsEnabled', tab: 'promptSuggestionsTab', label: 'promptSuggestions', hint: 'promptSuggestionsHint', steps: ['promptSuggestionsWhen', 'promptSuggestionsAccept', 'promptSuggestionsModel'] },
  { field: 'gitEnabled', tab: 'gitTab', label: 'git', hint: 'gitHint', steps: ['gitBranch', 'gitChanges', 'gitPullRequests'] },
]
const TABS: readonly { id: SettingsTab; label: LocaleKey }[] = [
  { id: 'computer', label: 'computerTab' },
  ...FEATURES.filter(feature => feature.field !== 'conversationCommentsEnabled').map(feature => ({ id: feature.field, label: feature.tab })),
  { id: 'qTheme', label: 'qThemeTab' },
  { id: 'about', label: 'aboutTab' },
  { id: 'updates', label: 'updatesTab' },
]

function SettingsIcon({ name }: { name: SettingsTab }) {
  if (name === 'computer') return <ComputerIcon/>
  if (name === 'gitEnabled') return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="6" cy="5" r="2.5"/><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/><path d="M6 7.5v9M18 7.5v2a6 6 0 0 1-6 6H6"/></svg>
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {name === 'pastedTextEnabled' ? <><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" /><path d="M14 3v5h5M8 12h8M8 16h6" /></>
      : name === 'sessionWindowsEnabled' ? <><rect x="3" y="7" width="14" height="14" rx="2" /><path d="M7 7V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2M3 12h14" /></>
        : name === 'bulkArchiveEnabled' ? <><rect x="3" y="4" width="18" height="5" rx="1.5" /><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M9 13h6M9 16h6" /></>
          : name === 'planCommentsEnabled' || name === 'conversationCommentsEnabled' ? <><path d="M12 20H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v6M7 7h9M7 11h5" /><path d="m14 17 5-5 3 3-5 5-4 1zM18 13l3 3" /></>
            : name === 'sidebarToolsEnabled' ? <><path d="M4 6h16M4 12h10M4 18h7"/><circle cx="18" cy="17" r="3"/><path d="m20.5 19.5 2 2"/></>
            : name === 'promptSuggestionsEnabled' ? <><path d="m4 20 4-1 11-11-3-3L5 16zM14 7l3 3M5 3v4M3 5h4M19 14v6M16 17h6"/></>
            : name === 'qTheme' ? <><path d="M12 3a9 9 0 1 0 0 18h1.4a2 2 0 0 0 1.5-3.3 1.5 1.5 0 0 1 1.1-2.5h1a4 4 0 0 0 4-4C21 6.7 17 3 12 3Z"/><path d="M7.5 11h.01M9 7.5h.01M13 7h.01M16.5 9h.01" strokeWidth="3"/></>
              : name === 'updates' ? <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 11.5-1.5L20 8M4 16l2.5 2.5A7 7 0 0 0 18 17"/></>
                : <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></>}
  </svg>
}

function themeStyle(theme: ThemeDefinition): React.CSSProperties {
  return {
    '--qyt-theme-art': `url("${theme.art}")`,
    '--qyt-theme-color': theme.accent,
    '--qyt-theme-color-dark': theme.accentDark,
    '--qyt-theme-solid': theme.accent,
    '--qyt-theme-seed': theme.soft,
    '--qyt-theme-banner-position': theme.bannerPosition ?? 'right 56%',
    '--qyt-theme-preview-position': theme.previewPosition ?? 'center',
  } as React.CSSProperties
}

export function QiuYaToolsSettings({ form, t, ctx }: SettingsProps) {
  const updates = getUpdateNotice(ctx)
  const updateState = useSyncExternalStore(updates.subscribe, updates.getSnapshot, updates.getSnapshot)
  const workbenchAPI = useMemo(() => createWorkbenchAPI(() => ctx.get('connection') as WorkbenchConnection | undefined), [ctx])
  const snapshot = useSyncExternalStore(
    listener => form.subscribe(listener),
    () => form.getSnapshot(),
    () => form.getSnapshot(),
  )
  const windowSupport = getSessionWindowSupport(ctx)
  const windowCompatibility = useSyncExternalStore(windowSupport.subscribe, windowSupport.getSnapshot, windowSupport.getSnapshot)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [thresholdDraft, setThresholdDraft] = useState<ThresholdDraft | null>(null)
  const [thresholdError, setThresholdError] = useState<'invalidCharacters' | 'invalidLines' | null>(null)
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => consumeUpdatesSettingsNavigation(ctx) ? 'updates' : consumeComputerSettingsNavigation(ctx) ? 'computer' : 'pastedTextEnabled')
  const [aboutVisited, setAboutVisited] = useState(false)
  const [updatesVisited, setUpdatesVisited] = useState(() => activeTab === 'updates')
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const themeCards = useRef<(HTMLButtonElement | null)[]>([])
  const pendingWrite = useRef(false)
  const id = useId()
  const ready = snapshot.status === 'ready'
  const preferences = { ...DEFAULT_PREFERENCES, ...snapshot.value }
  const themeId = getQThemeId(preferences)
  const theme = getQTheme(themeId)
  const themeMotion = getThemeMotion(preferences, themeId)
  const availableFeatures = FEATURE_FIELDS.filter(field => field !== 'sessionWindowsEnabled' || windowCompatibility.versionSupported)
  const allEnabled = availableFeatures.every(field => isFeatureEnabled(preferences, field))
  const anyEnabled = availableFeatures.some(field => isFeatureEnabled(preferences, field))
  const disabled = !ready || !snapshot.writable || saveState === 'saving'
  const draft: ThresholdDraft = thresholdDraft ?? {
    characters: String(preferences.pasteCharacterThreshold),
    lines: String(preferences.pasteLineThreshold),
  }
  const thresholdDirty = draft.characters !== String(preferences.pasteCharacterThreshold)
    || draft.lines !== String(preferences.pasteLineThreshold)

  function activateTab(tab: SettingsTab): void {
    if (tab === 'about') setAboutVisited(true)
    if (tab === 'updates') setUpdatesVisited(true)
    setActiveTab(tab)
    tabs.current[TABS.findIndex(item => item.id === tab)]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }
  useEffect(() => subscribeComputerSettingsNavigation(ctx, () => { if (consumeComputerSettingsNavigation(ctx)) activateTab('computer') }), [ctx])
  useEffect(() => subscribeUpdatesSettingsNavigation(ctx, () => { if (consumeUpdatesSettingsNavigation(ctx)) activateTab('updates') }), [ctx])

  function navigateTabs(event: React.KeyboardEvent<HTMLButtonElement>, index: number): void {
    const next = event.key === 'ArrowRight' ? (index + 1) % TABS.length
      : event.key === 'ArrowLeft' ? (index - 1 + TABS.length) % TABS.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : undefined
    if (next === undefined) return
    event.preventDefault()
    activateTab(TABS[next].id)
    tabs.current[next]?.focus()
  }

  async function persist(operations: FormOperations): Promise<boolean> {
    if (disabled || pendingWrite.current) return false
    pendingWrite.current = true
    setSaveState('saving')
    try {
      const accepted = await form.mutate(operations)
      setSaveState(accepted ? 'saved' : 'error')
      return accepted
    } catch {
      setSaveState('error')
      return false
    } finally {
      pendingWrite.current = false
    }
  }

  async function setAllFeatures(value: boolean): Promise<void> {
    await persist([
      { op: 'set', path: ['enabled'], value: true },
      ...FEATURE_FIELDS.map(field => ({ op: 'set' as const, path: [field], value: value && (field !== 'sessionWindowsEnabled' || windowCompatibility.versionSupported) })),
    ])
  }

  async function setFeature(field: FeatureField, value: boolean): Promise<void> {
    if (value && field === 'sessionWindowsEnabled' && !windowCompatibility.versionSupported) return
    await persist([
      { op: 'set', path: ['enabled'], value: true },
      { op: 'set', path: [field], value },
    ])
  }

  async function setThemeEnabled(value: boolean): Promise<void> {
    await persist([{ op: 'set', path: ['qThemeEnabled'], value }])
  }

  async function selectTheme(value: QThemeId): Promise<void> {
    if (value === themeId) return
    await persist([{ op: 'set', path: ['qThemeId'], value }])
  }

  function navigateThemes(event: React.KeyboardEvent<HTMLButtonElement>, index: number): void {
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (index + 1) % Q_THEMES.length
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (index - 1 + Q_THEMES.length) % Q_THEMES.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? Q_THEMES.length - 1 : undefined
    if (next === undefined || disabled) return
    event.preventDefault()
    themeCards.current[next]?.focus()
    void selectTheme(Q_THEMES[next].id)
  }

  async function setThemeMotion(value: ThemeMotion): Promise<void> {
    if (value === themeMotion) return
    await persist([{ op: 'set', path: ['qThemeSettings', themeId, 'motion'], value }])
  }

  function editThreshold(field: keyof ThresholdDraft, value: string): void {
    setThresholdDraft({ ...draft, [field]: value })
    setThresholdError(null)
    if (saveState !== 'saving') setSaveState('idle')
  }

  async function saveThresholds(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (disabled) return
    const characters = parsePasteThreshold(draft.characters, 'characters')
    if (characters === undefined) { setThresholdError('invalidCharacters'); return }
    const lines = parsePasteThreshold(draft.lines, 'lines')
    if (lines === undefined) { setThresholdError('invalidLines'); return }
    setThresholdError(null)
    if (await persist([
      { op: 'set', path: ['pasteCharacterThreshold'], value: characters },
      { op: 'set', path: ['pasteLineThreshold'], value: lines },
    ])) setThresholdDraft(null)
  }

  return (
    <section className="qyt-settings" data-theme={themeId} style={themeStyle(theme)} aria-label={t('nav')}>
      <div className="qyt-fixed">
        <header className="qyt-header">
          <span className="qyt-brand" aria-hidden="true"><span style={{ maskImage: `url("${MONO_ICON_DATA_URL}")`, WebkitMaskImage: `url("${MONO_ICON_DATA_URL}")` }} /></span>
          <div className="qyt-heading">
            <div className="qyt-title-row"><h2>{t('title')}</h2><span className="qyt-version">v{pkg.version}</span>{updateState.notice && <button className="qyt-update-badge" type="button" onClick={() => activateTab('updates')} title={`v${updateState.notice.version}`}>{t(updateState.notice.restart ? 'updateRestartRequired' : 'updateAvailable')}</button>}</div>
            <span className="qyt-status" role={saveState === 'error' ? 'alert' : 'status'} data-state={ready ? allEnabled ? 'ready' : anyEnabled ? 'partial' : 'paused' : 'pending'}><span className="qyt-status-dot" />{t(!ready ? snapshot.status === 'loading' ? 'loading' : 'unavailable' : !snapshot.writable ? 'readOnly' : saveState === 'error' ? 'saveError' : saveState === 'saving' ? 'saving' : saveState === 'saved' ? 'saved' : allEnabled ? windowCompatibility.versionSupported ? 'ready' : 'readyAvailable' : anyEnabled ? 'partial' : 'paused')}</span>
          </div>
          <div className="qyt-header-actions"><span>{t('enabled')}</span><button type="button" className="qyt-master-toggle" role="checkbox" aria-label={t('enabled')} aria-checked={allEnabled ? true : anyEnabled ? 'mixed' : false} title={t(allEnabled ? 'ready' : anyEnabled ? 'partial' : 'paused')} disabled={disabled} onClick={() => { void setAllFeatures(!allEnabled) }}><span aria-hidden="true" /></button></div>
        </header>
      </div>

      <div className="qyt-tabs" role="tablist" aria-label={t('features')} aria-orientation="horizontal">
        {TABS.map((tab, index) => <button key={tab.id} ref={element => { tabs.current[index] = element }} type="button" role="tab" id={`${id}-tab-${tab.id}`} aria-selected={activeTab === tab.id} aria-controls={`${id}-panel-${tab.id}`} tabIndex={activeTab === tab.id ? 0 : -1} onClick={() => { activateTab(tab.id) }} onKeyDown={event => { navigateTabs(event, index) }}>
          <SettingsIcon name={tab.id} /><span>{t(tab.label)}</span>{tab.id === 'updates' && updateState.notice && <span className="qyt-update-dot" aria-label={t(updateState.notice.restart ? 'updateRestartRequired' : 'updateAvailable')}/>}
        </button>)}
      </div>

      {TABS.map(tab => <div className="qyt-tab-panel" key={tab.id} role="tabpanel" id={`${id}-panel-${tab.id}`} aria-labelledby={`${id}-tab-${tab.id}`} hidden={activeTab !== tab.id} tabIndex={0}>
        {tab.id === 'computer' ? activeTab === 'computer' && <><ComputerPanel ctx={ctx} enabled={preferences.enabled !== false && preferences.computerUseEnabled === true} disabled={disabled} onEnabled={value => { void persist([...(value ? [{ op: 'set' as const, path: ['enabled'], value: true }] : []), { op: 'set', path: ['computerUseEnabled'], value }]) }}/><SitePermissions api={workbenchAPI}/></>
          : tab.id === 'about' ? aboutVisited && <AboutPanel version={pkg.version} ctx={ctx} />
          : tab.id === 'updates' ? updatesVisited && <UpdatePanel version={pkg.version} ctx={ctx} automatic={{ enabled: preferences.autoCheckUpdates !== false, disabled, label: t('autoCheckUpdates'), hint: t('autoCheckUpdatesHint'), onChange: value => { void persist([{ op: 'set', path: ['autoCheckUpdates'], value }]) } }} />
            : tab.id === 'qTheme' ? activeTab === 'qTheme' && <div className="qyt-feature-panel">
              <div className="qyt-card qyt-feature-summary">
                <div className="qyt-toggle-row"><div className="qyt-feature-heading"><span className="qyt-feature-icon"><SettingsIcon name="qTheme"/></span><h3>{t('qTheme')}</h3></div><Switch className="qyt-switch" checked={preferences.qThemeEnabled === true} label={t('qTheme')} disabled={disabled} onChange={value => { void setThemeEnabled(value) }}/></div>
                <p className="qyt-muted">{t('qThemeHint')}</p>
              </div>
              <div className="qyt-card qyt-theme-card" data-theme={themeId} style={themeStyle(theme)}>
                <div className="qyt-theme-title"><div className="qyt-theme-controls"><h4>{t(theme.name)}</h4><div className="qyt-theme-motion" role="radiogroup" aria-label={t(theme.motionLabel)}>
                  {(['dynamic', 'static'] as const).map(motion => <label key={motion}><input type="radio" name={`${id}-${themeId}-motion`} value={motion} checked={themeMotion === motion} disabled={disabled} onChange={() => { void setThemeMotion(motion) }}/><span>{t(motion === 'dynamic' ? 'qThemeMotionDynamic' : 'qThemeMotionStatic')}</span></label>)}
                </div></div><span className="qyt-theme-name">{theme.label}</span></div>
                <div className="qyt-theme-preview" role="img" aria-label={t(theme.description)}>
                  <ThemePreview ctx={ctx} form={form} theme={theme} title={t(theme.description)}/>
                </div>
                <div className="qyt-theme-caption"><p className="qyt-muted">{t(theme.hint)}</p><span className="qyt-theme-swatches" aria-hidden="true"><i/><i/><i/></span></div>
              </div>
              <div className="qyt-theme-choices" role="radiogroup" aria-label={t('qThemeChoose')}>
                {Q_THEMES.map((option, index) => <button key={option.id} ref={element => { themeCards.current[index] = element }} type="button" role="radio" className="qyt-theme-choice" data-theme={option.id} style={themeStyle(option)} aria-label={t(option.name)} aria-checked={themeId === option.id} tabIndex={themeId === option.id ? 0 : -1} disabled={disabled} onClick={() => { void selectTheme(option.id) }} onKeyDown={event => { navigateThemes(event, index) }}>
                  <span className="qyt-theme-thumbnail" aria-hidden="true"/>
                  <span className="qyt-theme-choice-name">{t(option.name)}</span>
                  <span className="qyt-theme-choice-circle" aria-hidden="true">{themeId === option.id && <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m4 8 3 3 5-6"/></svg>}</span>
                  <span className="qyt-sr-only">{themeId === option.id ? t('qThemeSelected') : ''}</span>
                </button>)}
              </div>
            </div> : activeTab === tab.id && FEATURES.filter(feature => feature.field === tab.id || tab.id === 'planCommentsEnabled' && feature.field === 'conversationCommentsEnabled').map(feature => <div className="qyt-feature-panel" key={feature.field}>
          <div className="qyt-card qyt-feature-summary">
            <div className="qyt-toggle-row">
              <div className="qyt-feature-heading"><span className="qyt-feature-icon"><SettingsIcon name={feature.field} /></span><h3>{t(feature.label)}</h3></div>
              <Switch className="qyt-switch" checked={isFeatureEnabled(preferences, feature.field) && (feature.field !== 'sessionWindowsEnabled' || windowCompatibility.versionSupported)} label={t(feature.label)} disabled={disabled || (feature.field === 'sessionWindowsEnabled' && !windowCompatibility.versionSupported)} onChange={value => { void setFeature(feature.field, value) }} />
            </div>
            <p className="qyt-muted">{t(feature.hint)}</p>
          </div>
          {feature.field === 'pastedTextEnabled' ? <form className="qyt-card qyt-thresholds" noValidate aria-label={t('pasteThresholds')} onSubmit={event => { void saveThresholds(event) }}>
            <h4>{t('pasteThresholds')}</h4>
            <p className="qyt-muted">{t('pasteThresholdHint')}</p>
            <div className="qyt-threshold-fields">
              <label className="qyt-number-field">
                <span>{t('characterThreshold')}</span>
                <input type="number" inputMode="numeric" min={1} max={1_000_000} step={1} value={draft.characters} disabled={disabled} aria-invalid={thresholdError === 'invalidCharacters'} onChange={event => { editThreshold('characters', event.target.value) }} />
                <span className="qyt-muted">{t('characterRange')}</span>
              </label>
              <label className="qyt-number-field">
                <span>{t('lineThreshold')}</span>
                <input type="number" inputMode="numeric" min={1} max={100_000} step={1} value={draft.lines} disabled={disabled} aria-invalid={thresholdError === 'invalidLines'} onChange={event => { editThreshold('lines', event.target.value) }} />
                <span className="qyt-muted">{t('lineRange')}</span>
              </label>
            </div>
            <div className="qyt-threshold-footer"><p className="qyt-feedback" role={thresholdError === null ? 'status' : 'alert'}>{thresholdError === null ? t('thresholdDraft') : t(thresholdError)}</p><button className="qyt-button" type="submit" disabled={disabled || !thresholdDirty}>{t('saveThresholds')}</button></div>
          </form> : <div className="qyt-card qyt-guide"><h4>{t('howToUse')}</h4>
            {feature.field === 'sessionWindowsEnabled' && <>
              <p className="qyt-muted">{t('sessionWindowsMinimum')} <strong>{MINIMUM_SESSION_WINDOW_HARNESS_VERSION}</strong></p>
              {!windowCompatibility.versionSupported && <p className="qyt-feedback" role="status">{t(windowCompatibility.status === 'checking' ? 'sessionWindowsVersionChecking' : windowCompatibility.status === 'ready' ? 'sessionWindowsVersionUnsupported' : 'sessionWindowsVersionUnknown')}{windowCompatibility.harnessVersion && <> {t('sessionWindowsCurrentVersion')} {windowCompatibility.harnessVersion}</>}</p>}
            </>}
            <ol>{feature.steps.map(step => <li key={step}>{t(step)}</li>)}</ol></div>}
        </div>)}
      </div>)}
    </section>
  )
}

export const inject = ['slots', 'locale', 'configForms', 'connection']

/** Every contribution leaves with the plugin fiber, including styles and feature listeners. */
export function apply(ctx: Context): void {
  ctx.effect(() => installEarlySessionWindowNavigation(ctx))
  ctx.effect(() => ctx.locale.register(NS, { zh, en }))
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-qiuya-tools'
    style.textContent = computerVisualStyles + css.replaceAll('__QYT_OCEAN_SCENE__', OCEAN_SCENE_DATA_URL)
    document.head.append(style)
    return () => { style.remove() }
  })
  ctx.inject(['uiConversation', 'sidebarRight', 'sidebarRightTabs', 'resources'], child => { child.effect(() => installAcceptanceRunClient(child)); child.effect(() => installAcceptanceWorkflowClient(child)); child.effect(() => installAcceptanceTemplateClient(child)); child.effect(() => installBrowserDiagnosticClient(child, { feature: { subscribe: listener => form.subscribe(listener), getSnapshot() { const snapshot = form.getSnapshot(); return snapshot.status === 'ready' && snapshot.value?.enabled !== false && snapshot.value?.computerUseEnabled === true } } })) })
  const t = ctx.locale.bind(NS)
  const form = ctx.configForms.get<Preferences>(SETTINGS_ID)
  const updateNotice = getUpdateNotice(ctx)
  ctx.effect(() => () => disposeUpdateNotice(ctx, updateNotice))
  ctx.inject(['connection'], child => { child.effect(() => installAutomaticUpdateChecks(ctx, form, { disposeStore: false })) })
  ctx.effect(() => installQTheme(ctx, form))
  ctx.effect(() => installChatComputerEnvironment(ctx, form))
  ctx.inject(['sidebarRight', 'sidebarRightTabs', 'resources', 'sessions'], child => { child.effect(() => installWorkbenchClient(child, form)) })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SETTINGS_ID,
    order: 50,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ form, ctx }),
  }, QiuYaToolsSettings))
  const updateBadge = { source: updateNotice, label: (restart: boolean) => t(restart ? 'updateRestartRequired' : 'updateAvailable'), open: () => { openUpdatesSettings(ctx) } }
  ctx.effect(() => installAccountMenuEntry(ctx, () => t('nav'), window, updateBadge))
  ctx.effect(() => installSettingsNavIcon(ctx, window, updateBadge))
  installFeatures(ctx, form)
}
