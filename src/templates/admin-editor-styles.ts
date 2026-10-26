// Editor chrome stylesheet for the block editor page (the edit page's CSP
// allows inline styles). Everything here sits on top of the site theme:
// the page body is never wrapped or restyled, so View mode renders the
// public page. Colors derive from the theme's --rkr-* tokens; the font is
// a system UI stack so chrome looks the same under every theme.

const TOKENS = `
.rkr-unified-shell,[data-rkr-dialog],.rkr-block-toolbar{
--rkr-edit-accent:var(--rkr-link);
--rkr-edit-surface:color-mix(in srgb,var(--rkr-bg) 94%,var(--rkr-text));
--rkr-edit-border:color-mix(in srgb,var(--rkr-rule) 78%,var(--rkr-text));
--rkr-edit-muted:var(--rkr-muted);
--rkr-edit-danger:var(--rkr-danger,#c0392b);
--rkr-edit-radius:6px;
--rkr-edit-shadow:0 1px 2px rgb(0 0 0/.1),0 8px 24px rgb(0 0 0/.16);
--rkr-edit-font:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;
--rkr-edit-dot:var(--rkr-edit-muted)}
.rkr-unified-shell[data-save-state="clean"]{--rkr-edit-dot:#2e7d4f}
.rkr-unified-shell[data-save-state="editing"]{--rkr-edit-dot:#b7791f}
.rkr-unified-shell[data-save-state="saving"]{--rkr-edit-dot:var(--rkr-edit-accent)}
.rkr-unified-shell[data-save-state="unsaved"]{--rkr-edit-dot:var(--rkr-edit-danger)}
`;

const BUTTON = `
.rkr-edit-btn{box-sizing:border-box;min-height:2.25rem;margin:0;padding:.45rem .95rem;font:500 .875rem/1.2 var(--rkr-edit-font);letter-spacing:normal;text-transform:none;color:var(--rkr-text);background:var(--rkr-bg);border:1px solid var(--rkr-edit-border);border-radius:var(--rkr-edit-radius);box-shadow:none;cursor:pointer}
.rkr-edit-btn:hover{background:color-mix(in srgb,var(--rkr-bg) 90%,var(--rkr-text))}
.rkr-edit-btn.is-primary{color:var(--rkr-bg);background:var(--rkr-edit-accent);border-color:var(--rkr-edit-accent)}
.rkr-edit-btn.is-primary:hover{background:color-mix(in srgb,var(--rkr-edit-accent) 86%,#000)}
.rkr-edit-btn.is-quiet{background:transparent;border-color:transparent}
.rkr-edit-btn.is-quiet:hover{border-color:var(--rkr-edit-border)}
.rkr-edit-btn:disabled,.rkr-edit-btn.is-busy{opacity:.5;cursor:default}
.rkr-edit-btn[hidden]{display:none}
:is(.rkr-edit-btn,.rkr-dialog-close,.rkr-blocks-palette-item,.rkr-unified-mode,.rkr-block-action,.rkr-segment):focus-visible{outline:2px solid var(--rkr-edit-accent);outline-offset:2px}
`;

const TOOLBAR = `
.rkr-unified-toolbar{position:sticky;top:.5rem;z-index:40;display:flex;align-items:center;flex-wrap:wrap;gap:.5rem .75rem;margin:0 0 1rem;padding:.5rem .75rem;color:var(--rkr-text);background:var(--rkr-edit-surface);border:1px solid var(--rkr-edit-border);border-radius:var(--rkr-edit-radius);box-shadow:var(--rkr-edit-shadow);font:400 .875rem/1.2 var(--rkr-edit-font)}
.rkr-unified-title{flex:1 1 8rem;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:1rem}
.rkr-unified-modes{display:inline-flex;gap:2px;padding:2px;background:var(--rkr-bg);border:1px solid var(--rkr-edit-border);border-radius:var(--rkr-edit-radius)}
.rkr-unified-mode{min-height:1.9rem;padding:.25rem .85rem;font:500 .875rem/1.2 var(--rkr-edit-font);color:var(--rkr-text);background:transparent;border:0;border-radius:4px;cursor:pointer}
.rkr-unified-mode[aria-pressed="true"]{color:var(--rkr-bg);background:var(--rkr-edit-accent)}
.rkr-unified-save-state{display:inline-flex;align-items:center;gap:.4rem;padding:.25rem .65rem;font-size:.8125rem;color:var(--rkr-edit-muted);border:1px solid var(--rkr-edit-border);border-radius:999px}
.rkr-unified-save-state::before{content:"";flex:none;width:.5rem;height:.5rem;border-radius:50%;background:var(--rkr-edit-dot)}
.rkr-unified-preview[aria-pressed="true"]{color:var(--rkr-edit-accent);border-color:var(--rkr-edit-accent)}
.rkr-unified-shell[data-mode="view"] :is(.rkr-unified-save,.rkr-unified-settings){display:none}
@media (min-width:601px){.rkr-unified-shell[data-phone] .rkr-blocks-page-body{box-sizing:border-box;width:100%;max-width:390px;justify-self:center;padding:0 .75rem;border:1px solid var(--rkr-edit-border);border-radius:14px;box-shadow:var(--rkr-edit-shadow)}}
@media (max-width:600px){
.rkr-unified-preview{display:none}
.rkr-unified-toolbar{display:grid;grid-template-columns:auto 1fr auto auto;align-items:center;gap:.35rem .5rem;padding:.35rem .5rem}
.rkr-unified-title{grid-column:1/4;grid-row:1}
.rkr-unified-save-state{grid-column:4;grid-row:1;justify-self:end;padding:.15rem .55rem}
.rkr-unified-modes{grid-column:1;grid-row:2}
.rkr-unified-settings{grid-column:3;grid-row:2}
.rkr-unified-save{grid-column:4;grid-row:2}
.rkr-unified-toolbar .rkr-edit-btn{min-height:2rem;padding:.25rem .75rem;white-space:nowrap}
.rkr-unified-mode{min-height:1.6rem}
}
`;

const PALETTE = `
.rkr-unified-layout{display:grid;gap:1.5rem;grid-template-columns:minmax(0,1fr)}
.rkr-unified-shell[data-mode="edit"] .rkr-unified-layout{grid-template-columns:minmax(0,1fr) 17rem}
.rkr-blocks-palette-right{position:sticky;top:5rem;align-self:start;max-height:calc(100vh - 6rem);overflow:auto;box-sizing:border-box;padding:.75rem;color:var(--rkr-text);background:var(--rkr-edit-surface);border:1px solid var(--rkr-edit-border);border-radius:var(--rkr-edit-radius);font-family:var(--rkr-edit-font)}
.rkr-unified-shell[data-mode="view"] .rkr-blocks-palette-right{display:none}
.rkr-palette-title,.rkr-palette-group-title{margin:0;padding:0;border:0;font-family:var(--rkr-edit-font);letter-spacing:normal;text-transform:none}
.rkr-palette-title{font-size:.9375rem;font-weight:600;color:var(--rkr-text)}
.rkr-palette-group-title{margin:.9rem 0 .25rem;font-size:.75rem;font-weight:600;color:var(--rkr-edit-muted)}
.rkr-blocks-palette-item{display:flex;align-items:center;gap:.65rem;box-sizing:border-box;width:100%;margin:0;padding:.4rem .5rem;font:inherit;text-align:left;color:var(--rkr-text);background:transparent;border:1px solid transparent;border-radius:var(--rkr-edit-radius);cursor:grab}
.rkr-blocks-palette-item:hover{background:color-mix(in srgb,var(--rkr-bg) 88%,var(--rkr-text));border-color:var(--rkr-edit-border)}
.rkr-palette-icon{flex:none;display:grid;place-items:center;width:2rem;height:2rem;color:var(--rkr-edit-accent);background:var(--rkr-bg);border:1px solid var(--rkr-edit-border);border-radius:5px}
.rkr-palette-text{display:grid;gap:.1rem;min-width:0}
.rkr-palette-label{font-size:.875rem;font-weight:600;line-height:1.2}
.rkr-palette-desc{font-size:.75rem;line-height:1.3;color:var(--rkr-edit-muted)}
.rkr-add-fab,.rkr-sheet-scrim,.rkr-sheet-close{display:none}
@media (max-width:720px){
.rkr-unified-shell[data-mode="edit"] .rkr-unified-layout{grid-template-columns:minmax(0,1fr);padding-bottom:5rem}
.rkr-add-fab{position:fixed;right:1rem;bottom:1rem;z-index:44;min-height:3rem;padding:.5rem 1.4rem;font-size:1rem;font-weight:600;border-radius:999px;box-shadow:var(--rkr-edit-shadow)}
.rkr-unified-shell[data-mode="edit"] .rkr-add-fab{display:inline-flex;align-items:center}
.rkr-sheet-scrim.is-open{display:block;position:fixed;inset:0;z-index:45;background:rgb(0 0 0/.4)}
.rkr-blocks-palette-right{position:fixed;inset:auto 0 0 0;z-index:46;max-height:78dvh;padding:1rem 1rem 1.5rem;border-width:1px 0 0;border-radius:14px 14px 0 0;box-shadow:0 -8px 32px rgb(0 0 0/.25);transform:translateY(100%);visibility:hidden;transition:transform .2s ease-out,visibility 0s .2s}
.rkr-blocks-palette-right.is-open{transform:none;visibility:visible;transition:transform .2s ease-out}
.rkr-sheet-close{display:inline-flex;position:absolute;top:.5rem;right:.75rem}
.rkr-palette-title{font-size:1.0625rem;padding:.25rem 0 .25rem}
.rkr-blocks-palette-item{min-height:3.25rem;padding:.5rem}
.rkr-palette-icon{width:2.25rem;height:2.25rem}
.rkr-palette-label{font-size:.9375rem}
}
@media (prefers-reduced-motion:reduce){.rkr-blocks-palette-right{transition:none}}
`;

const BLOCKS = `
.rkr-unified-shell[data-mode="edit"] [data-rkr-path]{position:relative;scroll-margin:7rem 0 6rem}
.rkr-unified-shell[data-mode="edit"] [data-rkr-path]:hover:not([data-rkr-selected],:has([data-rkr-path]:hover)){outline:1px solid color-mix(in srgb,var(--rkr-edit-accent) 45%,transparent);outline-offset:4px}
.rkr-unified-shell[data-mode="edit"] [data-rkr-path][contenteditable]:focus{outline:none}
.rkr-block-outline{position:fixed;z-index:30;box-sizing:border-box;pointer-events:none;border:2px solid var(--rkr-edit-accent);border-radius:2px}
.rkr-block-outline[hidden]{display:none}
.rkr-unified-shell[data-mode="view"] :is(.rkr-unified-blank,.rkr-unified-empty){display:none}
.rkr-unified-shell[data-mode="edit"] .rkr-unified-blank{min-height:1.5em;outline:1px dashed var(--rkr-edit-border);outline-offset:4px}
.rkr-unified-shell[data-mode="edit"] [data-rkr-blank]:empty::before{content:"Type something…";color:var(--rkr-edit-muted)}
.rkr-unified-shell[data-mode="edit"] :is(.rkr-row,.rkr-col,.rkr-flow)[data-rkr-path]{min-height:2.5rem;outline:1px dashed color-mix(in srgb,var(--rkr-edit-accent) 30%,transparent);outline-offset:-1px}
.rkr-unified-shell[data-mode="edit"] :is(.rkr-row,.rkr-col,.rkr-flow)[data-rkr-path]::before{position:absolute;top:0;left:0;z-index:1;padding:0 .4rem;font:500 .6875rem/1.5 var(--rkr-edit-font);color:var(--rkr-edit-muted);background:var(--rkr-edit-surface);border:1px solid var(--rkr-edit-border);border-width:0 1px 1px 0;border-radius:0 0 4px 0;opacity:0;pointer-events:none}
.rkr-unified-shell[data-mode="edit"] :is(.rkr-row,.rkr-col,.rkr-flow)[data-rkr-path]:is(:hover,[data-rkr-selected])::before{opacity:1}
.rkr-unified-shell[data-mode="edit"] .rkr-row[data-rkr-path]::before{content:"Row"}
.rkr-unified-shell[data-mode="edit"] .rkr-col[data-rkr-path]::before{content:"Column"}
.rkr-unified-shell[data-mode="edit"] .rkr-flow[data-rkr-path]::before{content:"Flow"}
[data-drop="before"]{box-shadow:inset 0 3px 0 0 var(--rkr-edit-accent,var(--rkr-link))}
[data-drop="after"]{box-shadow:inset 0 -3px 0 0 var(--rkr-edit-accent,var(--rkr-link))}
[data-drop="inside"]{outline:2px dashed var(--rkr-edit-accent,var(--rkr-link));outline-offset:2px}
#rkroll-admin-status.is-error{color:var(--rkr-danger,#c0392b)}
.rkr-block-toolbar{position:fixed;z-index:35;display:flex;flex-wrap:wrap;align-items:center;gap:.15rem;max-width:calc(100vw - 8px);padding:.2rem .3rem;color:var(--rkr-text);background:var(--rkr-edit-surface);border:1px solid var(--rkr-edit-border);border-radius:var(--rkr-edit-radius);box-shadow:var(--rkr-edit-shadow);font:400 .75rem/1.2 var(--rkr-edit-font)}
.rkr-block-toolbar[hidden]{display:none}
.rkr-block-type{padding:0 .4rem;font-weight:600;color:var(--rkr-edit-muted)}
.rkr-block-action{margin:0;padding:.25rem .5rem;font:500 .75rem/1.2 var(--rkr-edit-font);color:var(--rkr-text);background:transparent;border:0;border-radius:4px;cursor:pointer}
.rkr-block-action:hover{background:color-mix(in srgb,var(--rkr-bg) 86%,var(--rkr-text))}
.rkr-block-delete:hover{color:var(--rkr-edit-danger)}
.rkr-block-action[hidden]{display:none}
.rkr-block-action:disabled{opacity:.4;cursor:default}
.rkr-block-drag{cursor:grab}
`;

const DIALOG = `
dialog.rkr-dialog{box-sizing:border-box;width:min(28rem,calc(100vw - 2rem));max-height:min(42rem,calc(100vh - 2rem));margin:auto;padding:0;overflow:hidden;color:var(--rkr-text);background:var(--rkr-edit-surface);border:1px solid var(--rkr-edit-border);border-radius:calc(var(--rkr-edit-radius) + 2px);box-shadow:var(--rkr-edit-shadow);font:400 .9375rem/1.45 var(--rkr-edit-font)}
dialog.rkr-dialog.is-wide{width:min(38rem,calc(100vw - 2rem))}
dialog.rkr-dialog[open]{display:flex;flex-direction:column}
dialog.rkr-dialog::backdrop{background:rgb(0 0 0/.45)}
.rkr-dialog-panel{display:flex;flex-direction:column;flex:1;min-height:0}
.rkr-dialog-head{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1rem 1.25rem .5rem}
.rkr-dialog .rkr-dialog-title{margin:0;padding:0;border:0;font:600 1.0625rem/1.3 var(--rkr-edit-font);letter-spacing:normal;text-transform:none;color:var(--rkr-text)}
.rkr-dialog-close{display:grid;place-items:center;flex:none;width:2rem;height:2rem;margin:0;padding:0;color:var(--rkr-edit-muted);background:transparent;border:0;border-radius:var(--rkr-edit-radius);cursor:pointer}
.rkr-dialog-close:hover{color:var(--rkr-text);background:color-mix(in srgb,var(--rkr-bg) 88%,var(--rkr-text))}
.rkr-dialog-body{flex:1;min-height:0;padding:.5rem 1.25rem 1.1rem;overflow:auto}
.rkr-dialog-fields{display:grid;gap:1rem}
.rkr-dialog-error{margin:0;padding:.5rem 1.25rem;font-size:.875rem;color:var(--rkr-edit-danger)}
.rkr-dialog-error[hidden]{display:none}
.rkr-dialog-foot{display:flex;justify-content:flex-end;gap:.5rem;padding:.75rem 1.25rem;border-top:1px solid var(--rkr-edit-border)}
@media (max-width:600px){
dialog.rkr-dialog:not(.rkr-source-dialog),dialog.rkr-dialog.is-wide:not(.rkr-source-dialog){width:100vw;max-width:100vw;height:100dvh;max-height:100dvh;margin:0;border:0;border-radius:0}
.rkr-dialog-foot{position:sticky;bottom:0;padding-bottom:max(.75rem,env(safe-area-inset-bottom));background:var(--rkr-edit-surface)}
}
`;

const FIELDS = `
.rkr-field,.rkr-figure-field{display:grid;gap:.35rem}
.rkr-field-hint{margin:0;font:400 .8125rem/1.4 var(--rkr-edit-font);color:var(--rkr-edit-muted)}
.rkr-dialog-fields .rkr-field-hint a{color:inherit}
.rkr-field label,.rkr-figure-field label{font:600 .8125rem/1.3 var(--rkr-edit-font);color:var(--rkr-text)}
:is(.rkr-field,.rkr-figure-field) :is(input,select,textarea){box-sizing:border-box;width:100%;min-height:2.25rem;margin:0;padding:.45rem .65rem;font:400 .9375rem/1.4 var(--rkr-edit-font);color:var(--rkr-text);background:var(--rkr-bg);border:1px solid var(--rkr-edit-border);border-radius:var(--rkr-edit-radius);box-shadow:none}
:is(.rkr-field,.rkr-figure-field) textarea{resize:vertical;line-height:1.5}
:is(.rkr-field,.rkr-figure-field) :is(input,select,textarea)::placeholder{color:var(--rkr-edit-muted);opacity:1}
:is(.rkr-field,.rkr-figure-field) :is(input,select,textarea):focus{outline:2px solid var(--rkr-edit-accent);outline-offset:-1px;border-color:var(--rkr-edit-accent)}
:is(.rkr-field,.rkr-figure-field) [aria-invalid="true"]{border-color:var(--rkr-edit-danger)}
`;

const MEDIA_DIALOG = `
dialog.rkr-dialog.is-wide:has(.rkr-media-dialog,.rkr-image-editor){width:min(46rem,calc(100vw - 2rem));max-height:min(48rem,calc(100vh - 2rem))}
.rkr-media-dialog{gap:1.25rem}
.rkr-confirm-text{margin:0}
.rkr-media-section{display:grid;gap:.6rem;margin:0;padding:0}
.rkr-dialog .rkr-media-heading{margin:0;padding:0;border:0;font:600 .8125rem/1.3 var(--rkr-edit-font);letter-spacing:normal;text-transform:none;color:var(--rkr-edit-muted)}
.rkr-media-list{display:grid;gap:.6rem;margin:0;padding:0;list-style:none}
.rkr-media-list:empty{display:none}
.rkr-media-dialog>.rkr-field{max-width:20rem}
.rkr-media-row{display:grid;grid-template-columns:72px minmax(0,1fr) auto;gap:.75rem;align-items:start;margin:0;padding:.6rem;background:var(--rkr-bg);border:1px solid var(--rkr-edit-border);border-radius:var(--rkr-edit-radius)}
.rkr-media-thumb{display:grid;place-items:center;width:72px;height:72px;overflow:hidden;font-size:.75rem;color:var(--rkr-edit-muted);background:var(--rkr-edit-surface);border:1px solid var(--rkr-edit-border);border-radius:4px}
.rkr-media-thumb img{display:block;width:100%;height:100%;object-fit:cover}
.rkr-media-fields{display:grid;gap:.5rem;min-width:0}
.rkr-media-actions{display:grid;gap:.15rem;justify-items:stretch}
.rkr-media-action{min-height:1.9rem;padding:.25rem .6rem;font-size:.8125rem;text-align:left}
.rkr-media-empty{margin:0;padding:1rem;text-align:center;color:var(--rkr-edit-muted);border:1px dashed var(--rkr-edit-border);border-radius:var(--rkr-edit-radius)}
.rkr-media-empty[hidden]{display:none}
.rkr-media-add{justify-self:start}
.rkr-layout-control{display:grid;gap:.6rem}
.rkr-segmented{display:flex;flex-wrap:wrap;gap:2px;padding:2px;justify-self:start;background:var(--rkr-bg);border:1px solid var(--rkr-edit-border);border-radius:var(--rkr-edit-radius)}
.rkr-segment{min-height:2rem;margin:0;padding:.3rem .8rem;font:500 .8125rem/1.2 var(--rkr-edit-font);color:var(--rkr-text);background:transparent;border:0;border-radius:4px;cursor:pointer}
.rkr-segment[aria-checked="true"]{color:var(--rkr-bg);background:var(--rkr-edit-accent)}
.rkr-layout-grid{display:grid;grid-template-columns:repeat(2,minmax(0,8rem));gap:.75rem}
.rkr-layout-grid[hidden]{display:none}
.rkr-image-editor #rkr-image-edit:not([hidden]){display:grid;gap:.9rem}
.rkr-image-tools{display:flex;flex-wrap:wrap;gap:.35rem}
.rkr-image-tool{min-height:2rem;padding:.3rem .7rem;font-size:.8125rem}
.rkr-image-preview{display:block;max-width:100%;max-height:50vh;margin:0 auto;object-fit:contain;background:var(--rkr-bg);border:1px solid var(--rkr-edit-border);border-radius:4px}
.rkr-image-preview[hidden]{display:none}
.rkr-image-adjust{display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));gap:.75rem}
.rkr-image-inline{display:flex;gap:.4rem;align-items:center}
.rkr-image-inline input[type="range"]{flex:1;min-width:0;padding:0;border:0;background:transparent}
.rkr-image-inline input[type="number"]{width:6rem;flex:none}
.rkr-image-steps summary{cursor:pointer;font-size:.8125rem;color:var(--rkr-edit-muted)}
.rkr-image-steps ol{margin:.4rem 0 0;padding-left:1.25rem;font-size:.8125rem}
.rkr-image-field{display:flex;flex-wrap:wrap;gap:.6rem;align-items:center}
dialog#rkr-source-picker.rkr-source-dialog{width:min(22rem,calc(100vw - 2rem));padding:0}
#rkr-source-picker .rkr-dialog-foot button{margin:0}
.rkr-source-actions{display:grid;gap:.4rem}
.rkr-source-actions .rkr-edit-btn{text-align:left}
@media (max-width:600px){
.rkr-media-row{grid-template-columns:56px minmax(0,1fr)}
.rkr-media-thumb{width:56px;height:56px}
.rkr-media-actions{grid-column:1/-1;display:flex;flex-wrap:wrap}
dialog.rkr-dialog.is-wide:has(.rkr-media-dialog,.rkr-image-editor){width:100vw;max-height:100dvh}
}
`;

export const EDITOR_CSS = [
  TOKENS,
  BUTTON,
  TOOLBAR,
  PALETTE,
  BLOCKS,
  DIALOG,
  FIELDS,
  MEDIA_DIALOG
].join('');
