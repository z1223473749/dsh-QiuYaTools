import { compareVersions, parseSemanticVersion } from '../../updates/version.ts'

export const MINIMUM_SESSION_WINDOW_HARNESS_VERSION = '0.2.1-rc.2'

export interface SessionWindowVersionCompatibility {
  harnessVersion?: string
  minimumHarnessVersion: string
  versionSupported: boolean
}

/** Only a valid running Harness version can authorize a native session window. */
export function sessionWindowVersionCompatibility(input: unknown): SessionWindowVersionCompatibility {
  const version = parseSemanticVersion(input)
  return {
    ...(version === undefined ? {} : { harnessVersion: version.version }),
    minimumHarnessVersion: MINIMUM_SESSION_WINDOW_HARNESS_VERSION,
    versionSupported: version !== undefined && compareVersions(version.version, MINIMUM_SESSION_WINDOW_HARNESS_VERSION) >= 0,
  }
}
