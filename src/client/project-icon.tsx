import React from 'react'

export function ProjectIcon({ kind }: { kind: 'github' | 'update' | 'arrow' | 'heart' }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'github' ? <><path d="M9 19c-4.3 1.3-4.3-2.2-6-2.6m12 5v-3.4a3 3 0 0 0-.8-2.3c2.7-.3 5.5-1.3 5.5-6A4.6 4.6 0 0 0 18.4 6a4.3 4.3 0 0 0-.1-3.3S17.2 2.3 15 4a11.7 11.7 0 0 0-6 0C6.8 2.3 5.7 2.7 5.7 2.7A4.3 4.3 0 0 0 5.6 6a4.6 4.6 0 0 0-1.3 3.2c0 4.7 2.8 5.7 5.5 6a3 3 0 0 0-.8 2.3v3.9" /></>
      : kind === 'update' ? <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 11.5-1.5L20 8M4 16l2.5 2.5A7 7 0 0 0 18 17"/></>
        : kind === 'heart' ? <path d="m12 20-7.3-7.3a4.7 4.7 0 0 1 6.6-6.6l.7.7.7-.7a4.7 4.7 0 0 1 6.6 6.6Z"/>
          : <path d="M7 17 17 7M7 7h10v10"/>}
  </svg>
}
