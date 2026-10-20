/** Kept under this feature's own marker so unloading cannot affect host selection styles. */
export const selectionMarker = 'data-qyt-bulk-selected'
export const bulkArchiveCSS = `
[data-slot="sidebar.workspaces"] [${selectionMarker}="true"] {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 18%, transparent) !important;
  box-shadow: inset 3px 0 var(--dsw-alias-brand-primary, #4d6bfe);
}
.qyt-bulk-archive { position: fixed; z-index: 10000; box-sizing: border-box;
  color: var(--dsw-alias-label-primary, #222); background: var(--dsw-alias-bg-layer-1, #fff);
  border: 1px solid var(--dsw-alias-border-l1, #ddd); border-radius: 10px;
  box-shadow: 0 6px 24px #0002; padding: 6px; font: 13px/1.5 system-ui; }
.qyt-bulk-archive button { border: 0; border-radius: 6px; background: transparent; color: inherit;
  font: inherit; padding: 8px 12px; cursor: pointer; text-align: left; }
.qyt-bulk-archive button:hover, .qyt-bulk-archive button:focus-visible { background: #80808020; }
.qyt-bulk-archive button:disabled { opacity: .5; cursor: not-allowed; }
.qyt-bulk-archive-menu button { display: block; width: 100%; }
.qyt-bulk-archive-menu { max-width: min(420px, calc(100vw - 24px)); }
.qyt-bulk-archive-failures { max-width: min(400px, calc(100vw - 36px)); padding: 4px 8px; color: var(--dsw-alias-label-secondary, #666); font: 12px/1.5 system-ui; overflow-wrap: anywhere; }
.qyt-bulk-archive-failures p { margin: 0 0 4px; }
.qyt-bulk-archive-failures ul { max-height: 160px; overflow: auto; margin: 0; padding-left: 18px; }
[data-qyt-workspace-archive], [data-qyt-selection-clear] { width: 100%; }
`
