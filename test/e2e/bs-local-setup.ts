// Playwright globalSetup: start BrowserStack Local tunnel before tests.
// The tunnel lets remote BrowserStack browsers reach the local webServer
// at localhost:PORT via the BS Local proxy.
import { bsLocal } from './bs-local-instance.ts';

export default async function globalSetup(): Promise<void> {
  const key = process.env.BROWSERSTACK_ACCESS_KEY;
  if (!key) throw new Error('BROWSERSTACK_ACCESS_KEY not set — add it to secrets.env');

  await new Promise<void>((resolve, reject) => {
    bsLocal.start({ key }, (err) => {
      if (err) reject(new Error(`BrowserStack Local failed to start: ${String(err)}`));
      else resolve();
    });
  });
  console.log('BrowserStack Local started');
}
