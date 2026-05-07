// Admin SPA shell.
//
// Loads TipTap from esm.sh via an import map, with each package pinned to
// its exact version. Subresource Integrity hashes are NOT yet attached —
// per spec §3 we want either a vendored copy or CDN+SRI for production.
// SRI is a deployment-hardening item before going public; documented as a
// follow-up. Versions are pinned so the served bytes don't drift mid-session.

const TIPTAP_VERSION = '3.22.5';

export interface AdminPageData {
  /** Where the compiled admin bundle is mounted on the URL space. */
  bundleUrl: string;
}

export function renderAdminPage(data: AdminPageData): string {
  const importMap = JSON.stringify(
    {
      imports: {
        '@tiptap/core': `https://esm.sh/@tiptap/core@${TIPTAP_VERSION}`,
        '@tiptap/pm/state': `https://esm.sh/@tiptap/pm@${TIPTAP_VERSION}/state`,
        '@tiptap/pm/view': `https://esm.sh/@tiptap/pm@${TIPTAP_VERSION}/view`,
        '@tiptap/pm/model': `https://esm.sh/@tiptap/pm@${TIPTAP_VERSION}/model`,
        '@tiptap/pm/transform': `https://esm.sh/@tiptap/pm@${TIPTAP_VERSION}/transform`,
        '@tiptap/pm/commands': `https://esm.sh/@tiptap/pm@${TIPTAP_VERSION}/commands`,
        '@tiptap/pm/keymap': `https://esm.sh/@tiptap/pm@${TIPTAP_VERSION}/keymap`,
        '@tiptap/pm/schema-list': `https://esm.sh/@tiptap/pm@${TIPTAP_VERSION}/schema-list`,
        '@tiptap/pm/dropcursor': `https://esm.sh/@tiptap/pm@${TIPTAP_VERSION}/dropcursor`,
        '@tiptap/pm/gapcursor': `https://esm.sh/@tiptap/pm@${TIPTAP_VERSION}/gapcursor`,
        '@tiptap/pm/inputrules': `https://esm.sh/@tiptap/pm@${TIPTAP_VERSION}/inputrules`,
        '@tiptap/pm/history': `https://esm.sh/@tiptap/pm@${TIPTAP_VERSION}/history`,
        '@tiptap/starter-kit': `https://esm.sh/@tiptap/starter-kit@${TIPTAP_VERSION}`
      }
    },
    null,
    2
  );

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
<style>
  /* Override site.css's body reset so the admin chrome keeps its own
     layout. The editor's prose preview lives inside <article> below,
     where site.css's prose rules apply naturally. */
  body {
    font-family: system-ui, sans-serif;
    max-width: 56rem;
    margin: 2rem auto;
    padding: 0 1rem;
    background: var(--rkr-bg, #fff);
    color: var(--rkr-text, #1a1a1a);
  }
  #rkroll-admin-toolbar { display: flex; gap: .25rem; flex-wrap: wrap; margin-bottom: 1rem; padding: .5rem; border: 1px solid #ccc; border-radius: 4px; }
  #rkroll-admin-toolbar button { padding: .25rem .75rem; cursor: pointer; font-family: system-ui, sans-serif; }
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
  #rkroll-admin-status { margin-top: .5rem; color: #666; font-size: .9rem; font-family: system-ui, sans-serif; }
  .rkr-meta { display: grid; grid-template-columns: max-content 1fr; gap: .5rem 1rem; margin-bottom: 1rem; align-items: center; font-family: system-ui, sans-serif; }
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
</div>
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
<script type="importmap">
${importMap}
</script>
<script type="module" src="${data.bundleUrl}"></script>
</body>
</html>
`;
}
