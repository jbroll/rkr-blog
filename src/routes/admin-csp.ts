// Per-response CSP + nonce for the admin editor.
//
// Split out of admin.ts (which sits at the 500-line size cap) so the
// nonce-generation + CSP-string assembly lives in its own module.
//
// Why a nonce: the editor is the highest-privilege page (post write +
// token-bearing picker endpoints + the bearer-only reset). The shell
// template emits one inline <style> block (ADMIN_CSS_CORE +
// ADMIN_CSS_DIALOGS). The editor JS is a single EXTERNAL, self-hosted
// module (<script type="module" src="/static/admin/main.js">), so it
// is already covered by `script-src 'self'` and needs no nonce — which
// means we can drop `'unsafe-inline'` from script-src outright (there
// is no inline script to keep alive). That closes the inline-script
// XSS vector on the privileged page.
//
// style-src KEEPS `'unsafe-inline'`: cropperjs sets element.style /
// .style.cssText at runtime (e.g. cropper.js sizing image), which CSP
// governs as inline style *attributes*. A <style>-element nonce does
// not whitelist inline style attributes, and `'unsafe-hashes'` support
// is uneven, so removing `'unsafe-inline'` from style-src would break
// the crop modal. The script vector is the priority and is fully
// closed; the nonce on the <style> element is still emitted so the
// directive can be tightened later if cropper's runtime styling is
// reworked.

import crypto from 'node:crypto';

/** Fresh per-response nonce (base64, 128 bits of entropy). */
export function makeCspNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

/**
 * Build the admin-editor CSP for a single response, binding the inline
 * <style> block to `nonce`. All non-script/style directives are
 * unchanged from the prior static policy.
 *
 * - script-src: `'self' https://apis.google.com` — NO `'unsafe-inline'`
 *   (the editor's only script is the external self-hosted bundle; the
 *   Drive picker SDK is the one third-party host, same trust as OAuth).
 * - style-src: `'self' 'nonce-<n>' 'unsafe-inline'` — the nonce binds
 *   the template's <style>; `'unsafe-inline'` is retained for
 *   cropperjs's runtime inline style attributes (see module header).
 */
export function buildAdminEditorCsp(nonce: string): string {
  return [
    "default-src 'self'",
    "script-src 'self' https://apis.google.com",
    `style-src 'self' 'nonce-${nonce}' 'unsafe-inline'`,
    "img-src 'self' data: blob: https://*.googleusercontent.com https://*.1drv.com https://*.onedrive.live.com https://*.svc.ms",
    "connect-src 'self' https://apis.google.com https://*.googleapis.com https://accounts.google.com https://login.microsoftonline.com",
    'frame-src https://docs.google.com https://accounts.google.com',
    // OneDrive picker opens as a popup (window.open), not an iframe, so
    // frame-src is not needed. popup-src is not a standard CSP directive;
    // popups inherit the opener's settings only for navigate-to / form-action.
    "form-action 'self' https://onedrive.live.com https://*.sharepoint.com",
    "font-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'"
  ].join('; ');
}
