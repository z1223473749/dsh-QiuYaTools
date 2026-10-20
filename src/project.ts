import pkg from '../package.json' with { type: 'json' }

/** Public project identity is shared by the About panel and the fixed-source updater. */
const manifest = pkg as typeof pkg & { repository?: string | { url?: string } }
const source = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
const match = /^git\+https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\.git$/u.exec(source ?? '')
  ?? /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/u.exec(source ?? '')
export const PROJECT_REPOSITORY = match ? `https://github.com/${match[1]}/${match[2]}` : undefined
export const PROJECT_ISSUES = PROJECT_REPOSITORY ? `${PROJECT_REPOSITORY}/issues` : undefined
export const PROJECT_RELEASES = PROJECT_REPOSITORY ? `${PROJECT_REPOSITORY}/releases` : undefined
