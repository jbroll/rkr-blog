// Shared BrowserStack Local instance. Imported by both bs-local-setup.ts
// and bs-local-teardown.ts. Since Playwright's globalSetup and globalTeardown
// run in the same Node.js process, the module cache is shared and the
// singleton instance is the same object in both phases.
import { Local } from 'browserstack-local';

export const bsLocal = new Local();
