// Admin SPA shell.
//
// TipTap and ProseMirror are bundled into the admin entry by esbuild
// (see `npm run build:admin`); the served bundle has no third-party
// network dependency at runtime, which keeps the editor's CSP tight
// (script-src 'self' only, no esm.sh / CDN allowance).

export interface AdminPageData {
  /** Where the compiled admin bundle is mounted on the URL space. */
  bundleUrl: string;
}

export function renderAdminPage(data: AdminPageData): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>rkroll admin</title>
<!-- Public theme: gives the editor preview the same look the published post
     will have (figures, prose width, headings, gallery/carousel placeholders).
     Loaded BEFORE the admin overrides so the inline styles below win for
     admin chrome (toolbar, panels, body layout). -->
<link rel="stylesheet" href="/static/site.css"/>
<!-- Cropper.js styles (extracted from the admin bundle by esbuild). -->
<link rel="stylesheet" href="/static/admin/main.css"/>
<style>
  /* Override site.css's body reset so the admin chrome keeps its own
     layout. The editor's prose preview lives inside <article> below,
     where site.css's prose rules apply naturally. */
  body {
    max-width: 56rem;
    margin: 2rem auto;
    padding: 0 1rem;
    background: var(--rkr-bg, #fff);
    color: var(--rkr-text, #1a1a1a);
  }
  /* Single font-family rule for all admin chrome (toolbar buttons,
     status, meta, panels). Site.css would otherwise impose its serif
     prose font on form controls, which is jarring for UI elements.
     The editable region inside <article> still gets the prose font. */
  body, button, input, select { font-family: system-ui, sans-serif; }
  #rkroll-admin-toolbar { display: flex; gap: .25rem; flex-wrap: wrap; margin-bottom: 1rem; padding: .5rem; border: 1px solid #ccc; border-radius: 4px; }
  #rkroll-admin-toolbar button { padding: .25rem .75rem; cursor: pointer; }
  #rkroll-admin-toolbar button.is-active { background: #333; color: white; }
  /* Editor preview frame: the ProseMirror editable lives inside an
     <article>, so site.css's prose typography (max-width, font-family,
     headings, blockquotes, code, hr) applies. We give it a visible
     box-style border + min-height so it's obvious where you can edit. */
  #rkroll-admin-root {
    margin-bottom: .5rem; padding: .25rem 1rem;
    border: 1px solid #ccc; border-radius: 4px;
  }
  #rkroll-admin-root .ProseMirror { min-height: 20rem; outline: none; }
  /* Site.css would normally constrain article width via max-width: --rkr-prose
     and hide overflow; in the editor we let it stretch to the editable box. */
  #rkroll-admin-root article { max-width: none; margin: 0; }
  #rkroll-admin-status { margin-top: .5rem; color: #666; font-size: .9rem; }
  .rkr-meta { display: grid; grid-template-columns: max-content 1fr; gap: .5rem 1rem; margin-bottom: 1rem; align-items: center; }
  .rkr-meta input, .rkr-meta select { padding: .25rem; }
  /* Attribute panels: shown only when a matching node is selected. */
  #rkr-image-attrs[hidden], #rkr-multi-attrs[hidden] { display: none; }
  #rkr-image-attrs, #rkr-multi-attrs {
    display: grid; grid-template-columns: max-content 1fr; gap: .35rem .75rem;
    align-items: center; margin: .75rem 0;
    padding: .5rem .75rem; border: 1px solid #ccc; border-radius: 4px; background: #f7f7f7;
  }
  #rkr-image-attrs h3, #rkr-multi-attrs h3 { grid-column: 1 / -1; margin: 0; font-size: .9rem; color: #555; }
  #rkr-image-attrs input, #rkr-image-attrs select,
  #rkr-multi-attrs input, #rkr-multi-attrs select { padding: .25rem; }
  /* Browser-native :out-of-range styling for autoplay (input has
     min=0/max=60 attrs). Gives the author a visual cue that >60 will
     be silently clamped on save by emitMultiImage. */
  #rkr-multi-autoplay:out-of-range {
    border: 1px solid #c00;
    background: #fee;
  }
  /* Editor-side previews of multi-image directives: a labelled chip + a
     thumbnail strip, just enough that the author sees what's grouped. */
  #rkroll-admin-root .rkr-multi {
    margin: 1rem 0; padding: .5rem; border: 1px dashed #aaa; border-radius: 4px; background: #fafafa;
  }
  #rkroll-admin-root .rkr-multi-label {
    font-family: ui-monospace, monospace; font-size: .8rem; color: #666; margin-bottom: .25rem;
    text-transform: uppercase; letter-spacing: .05em;
  }
  #rkroll-admin-root .rkr-multi-thumbs { display: flex; flex-wrap: wrap; gap: .35rem; }
  #rkroll-admin-root .rkr-multi-thumb {
    width: 6rem; height: 4rem; object-fit: cover; border-radius: 2px;
  }
  #rkroll-admin-root .rkr-multi-caption {
    margin-top: .35rem; color: #666; font-size: .85rem; font-style: italic;
  }
  /* Site.css's image positioning rules (rkr-pos-default, rkr-pos-full,
     rkr-pos-left, rkr-pos-right) target the public-page <figure> wrapper
     and assume the post is rendered inside the page's outer column. The
     editor's ImageNode emits a bare <img class="rkr-image rkr-pos-X">
     without that wrapper, so a user picking position=full would otherwise
     trigger width:100vw + negative-margin breakout that escapes the
     editor frame entirely. Clamp every editor image to the editable box;
     the actual breakout/float behavior takes effect only on the published
     page. Higher specificity than .rkr-pos-* so this wins without !important. */
  #rkroll-admin-root img.rkr-image {
    display: block;
    max-width: 100%;
    width: auto;
    height: auto;
    margin: .5rem 0;
  }
  /* Image-attribute action row + crop modal. */
  .rkr-image-actions { display: flex; gap: .5rem; }
  .rkr-image-actions button { padding: .25rem .75rem; cursor: pointer; }
  #rkr-crop-modal {
    border: 1px solid #ccc; border-radius: 6px; padding: 0;
    width: min(80vw, 60rem); max-width: 95vw; max-height: 90vh;
    background: #fff; color: #1a1a1a; box-shadow: 0 8px 32px rgba(0,0,0,.25);
  }
  #rkr-crop-modal::backdrop { background: rgba(0,0,0,.6); }
  #rkr-crop-modal .rkr-crop-stage {
    /* Cropper needs a contained stage that bounds the image so the
       handles render inside the modal rather than at full image size. */
    height: 60vh; max-height: 32rem; background: #222;
  }
  #rkr-crop-modal .rkr-crop-stage img {
    /* Cropper.js requires display:block + width:100% to attach handles. */
    display: block; max-width: 100%;
  }
  #rkr-crop-modal .rkr-crop-actions {
    display: flex; gap: .5rem; align-items: center; padding: .75rem;
    border-top: 1px solid #eee; justify-content: flex-end;
  }
  #rkr-crop-modal #rkr-crop-status { flex: 1; color: #666; font-size: .9rem; }
  #rkr-crop-modal button { padding: .35rem .85rem; cursor: pointer; }
</style>
</head>
<body>
<h1>New post</h1>
<div class="rkr-meta">
  <label for="rkr-title">Title</label>   <input id="rkr-title" type="text"/>
  <label for="rkr-slug">Slug</label>     <input id="rkr-slug" type="text"/>
  <label for="rkr-status">Status</label>
  <select id="rkr-status">
    <option value="draft" selected>draft</option>
    <option value="published">published</option>
  </select>
</div>
<div id="rkroll-admin-toolbar"></div>
<div id="rkr-image-attrs" hidden>
  <h3>Image attributes</h3>
  <label for="rkr-image-alt">Alt text</label>
  <input id="rkr-image-alt" type="text" placeholder="describe the image for screen readers"/>
  <label for="rkr-image-caption">Caption</label>
  <input id="rkr-image-caption" type="text" placeholder="optional caption shown below"/>
  <label for="rkr-image-position">Position</label>
  <select id="rkr-image-position">
    <option value="default">default (centered, breakout)</option>
    <option value="full">full (edge-to-edge)</option>
    <option value="left">left (float, prose wraps right)</option>
    <option value="right">right (float, prose wraps left)</option>
    <option value="inline">inline (small, in text flow)</option>
  </select>
  <span></span>
  <span class="rkr-image-actions">
    <button type="button" id="rkr-image-crop-btn">Crop…</button>
    <button type="button" id="rkr-image-rotate-l-btn" title="Rotate 90° counter-clockwise">↺</button>
    <button type="button" id="rkr-image-rotate-r-btn" title="Rotate 90° clockwise">↻</button>
    <button type="button" id="rkr-image-flip-h-btn" title="Flip horizontally">⇋</button>
    <button type="button" id="rkr-image-flip-v-btn" title="Flip vertically">⇕</button>
    <button type="button" id="rkr-image-reset-btn" hidden>Reset edits</button>
  </span>
  <label for="rkr-image-resample">Max width (px)</label>
  <span class="rkr-image-actions">
    <input id="rkr-image-resample" type="number" min="0" max="8000" step="50" placeholder="leave blank for none"/>
    <button type="button" id="rkr-image-resample-btn">Apply</button>
  </span>
</div>
<dialog id="rkr-crop-modal" aria-label="Crop image">
  <div class="rkr-crop-stage">
    <img id="rkr-crop-img" alt=""/>
  </div>
  <div class="rkr-crop-actions">
    <span id="rkr-crop-status"></span>
    <button type="button" id="rkr-crop-cancel">Cancel</button>
    <button type="button" id="rkr-crop-save">Save crop</button>
  </div>
</dialog>
<div id="rkr-multi-attrs" hidden>
  <h3 id="rkr-multi-attrs-label">Multi-image attributes</h3>
  <label for="rkr-multi-ids">IDs</label>
  <input id="rkr-multi-ids" type="text" readonly placeholder="comma-separated; populated by upload"/>
  <label for="rkr-multi-caption">Caption</label>
  <input id="rkr-multi-caption" type="text" placeholder="optional caption"/>
  <label for="rkr-multi-layout" id="rkr-multi-layout-label">Layout</label>
  <select id="rkr-multi-layout">
    <option value="justified">justified (Flickr-style rows)</option>
    <option value="masonry">masonry (Pinterest columns)</option>
    <option value="matrix">matrix (uniform grid)</option>
  </select>
  <label for="rkr-multi-autoplay" id="rkr-multi-autoplay-label">Autoplay (s)</label>
  <input id="rkr-multi-autoplay" type="number" min="0" max="60" step="1"/>
</div>
<div id="rkroll-admin-root">
  <article id="rkroll-admin-article"></article>
</div>
<div id="rkroll-admin-status"></div>
<input id="rkr-image-input" type="file" accept="image/*" hidden/>
<script type="module" src="${data.bundleUrl}"></script>
</body>
</html>
`;
}
