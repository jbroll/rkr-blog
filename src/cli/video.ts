// `site-admin video probe <path>` — print the ffprobe result JSON for a
// file so an operator can see whether an upload would be accepted
// (dimensions/duration caps live in config.ts) before ingesting it.

import { probeVideo, type VideoProbe } from '../lib/video-ffmpeg.ts';

/** probe is injectable so the CLI logic runs without ffmpeg on the
 * unit-test runner. */
export default async function probeVideoCli(
  argv: string[],
  probe: (filePath: string) => Promise<VideoProbe> = probeVideo
): Promise<void> {
  const [sub, filePath] = argv;
  if (sub !== 'probe' || !filePath) {
    throw new Error('usage: site-admin video probe <path>');
  }
  const result = await probe(filePath);
  console.log(JSON.stringify(result, null, 2));
}
