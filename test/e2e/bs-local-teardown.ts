// Playwright globalTeardown: stop BrowserStack Local tunnel after tests.
import { bsLocal } from './bs-local-instance.ts';

export default async function globalTeardown(): Promise<void> {
  if (!bsLocal.isRunning()) return;
  await new Promise<void>((resolve) => {
    bsLocal.stop(() => {
      console.log('BrowserStack Local stopped');
      resolve();
    });
  });
}
