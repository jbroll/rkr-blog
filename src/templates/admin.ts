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
<style>
  body { font-family: system-ui, sans-serif; max-width: 56rem; margin: 2rem auto; padding: 0 1rem; }
  #rkroll-admin-toolbar { display: flex; gap: .25rem; flex-wrap: wrap; margin-bottom: 1rem; padding: .5rem; border: 1px solid #ccc; border-radius: 4px; }
  #rkroll-admin-toolbar button { padding: .25rem .75rem; cursor: pointer; }
  #rkroll-admin-toolbar button.is-active { background: #333; color: white; }
  #rkroll-admin-root .ProseMirror { min-height: 20rem; padding: 1rem; border: 1px solid #ccc; border-radius: 4px; outline: none; }
  #rkroll-admin-root .ProseMirror img.rkr-image { max-width: 100%; height: auto; display: block; margin: 1rem auto; }
  #rkroll-admin-status { margin-top: .5rem; color: #666; font-size: .9rem; }
  .rkr-meta { display: grid; grid-template-columns: max-content 1fr; gap: .5rem 1rem; margin-bottom: 1rem; align-items: center; }
  .rkr-meta input, .rkr-meta select { padding: .25rem; }
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
<div id="rkroll-admin-root"></div>
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
