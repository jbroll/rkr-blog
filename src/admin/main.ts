// Admin SPA entry point. Compiled to static/admin/main.js by
// `npm run build:admin` and loaded by templates/admin.ts.
//
// Step 6a is the build-pipeline skeleton; the actual TipTap editor
// arrives in 6b/6c.

interface RkrollAdminGlobal {
  /** Set by the bootstrap; holds the mount root once the SPA wires up. */
  mounted?: boolean;
}

const globalSlot = (globalThis as unknown as { rkroll: RkrollAdminGlobal }).rkroll ?? {};
(globalThis as unknown as { rkroll: RkrollAdminGlobal }).rkroll = globalSlot;

function mount(): void {
  const root = document.getElementById('rkroll-admin-root');
  if (!root) {
    console.error('rkroll-admin: #rkroll-admin-root not found');
    return;
  }
  root.textContent = 'rkroll admin — editor coming in step 6b/6c';
  globalSlot.mounted = true;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
