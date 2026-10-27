/** Exact authenticated routes owned by QiuYaTools; the Client never chooses an install URL. */
export const UPDATES_CHANNEL = '/api'
export const UPDATES_CHECK_ENDPOINT = 'qiuya-tools.updates.check'
export const UPDATES_INSTALL_ENDPOINT = 'qiuya-tools.updates.install'
export const UPDATES_PROGRESS_ENDPOINT = 'qiuya-tools.updates.progress'

export type UpdateErrorCode = 'network' | 'timeout' | 'rate-limited' | 'invalid-release'
  | 'manager-unavailable' | 'profile-unavailable' | 'platform-unsupported' | 'asset-unavailable'
  | 'version-changed' | 'download-failed' | 'integrity-failed' | 'archive-invalid' | 'install-failed' | 'disposed'

export interface UpdateProblem { code: UpdateErrorCode; message: string }
export interface UpdateRelease {
  version: string
  tag: string
  url: string
  title: string
  notes: string
  publishedAt: string
}

export interface UpdateCheckResult {
  status: 'not-configured' | 'no-release' | 'up-to-date' | 'available' | 'error'
  currentVersion: string
  repository?: string
  release?: UpdateRelease
  canInstall: boolean
  /** Installed on disk; the running Host continues its current version until restarted. */
  pendingVersion?: string
  problem?: UpdateProblem
}

/** The requested version must still match GitHub's checked release before installation begins. */
export interface UpdateInstallRequest { version: string }
export interface UpdateInstallResult {
  status: 'restart-required' | 'installed' | 'already-current' | 'failed'
  currentVersion: string
  version?: string
  problem?: UpdateProblem
}

/** A snapshot of the active installation; byte progress comes only from the download stream. */
export interface UpdateInstallProgress {
  version: string
  stage: 'checking' | 'downloading' | 'verifying' | 'installing'
  downloadedBytes: number
  totalBytes: number | null
  percentage: number | null
}
export interface UpdateProgressResult { progress: UpdateInstallProgress | null }
