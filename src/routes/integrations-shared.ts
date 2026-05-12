// Shared request shapes for the gdrive + onedrive integration routes.
// Both providers expose the same Picker-style import flow:
//   - POST /admin/import/<provider>  body = { fileId, name, mimeType }
//   - GET  /admin/integrations/<provider>/callback?code=...&state=...
// Extracting these keeps the two route modules from declaring the same
// shapes; per-provider extras (e.g. OneDrive's error_description) are
// added by extending the base types.

/** POST body for /admin/import/<provider>. The user-facing handler
 * validates fields itself, so unknowns stay loose. */
export interface ProviderImportBody {
  fileId?: unknown;
  name?: unknown;
  mimeType?: unknown;
}

/** Query string for the OAuth callback. `error` is set by the provider
 * when the user denies consent or the request is malformed. */
export interface ProviderCallbackQuery {
  code?: string;
  state?: string;
  error?: string;
}
