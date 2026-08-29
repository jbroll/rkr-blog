// Thin spawn wrapper around ffmpeg/ffprobe for the video pipeline. No sharp
// here: transcode + poster extraction are plain spawn calls with stderr
// capture, a kill-on-timeout, and an actionable error when the binaries are
// missing.

import { spawn } from 'node:child_process';

const PROBE_TIMEOUT_MS = 10_000;

export interface FfmpegArgs {
  input: string;
  output: string;
  startMs?: number;
  endMs?: number;
  maxWidth?: number;
}

/** Normalized h264/aac mp4 transcode: optional trim, scale-to-fit, faststart. */
export function buildFfmpegArgs({
  input,
  output,
  startMs,
  endMs,
  maxWidth = 1920
}: FfmpegArgs): string[] {
  const args: string[] = [];
  if (startMs !== undefined) args.push('-ss', String(startMs / 1000));
  if (endMs !== undefined) args.push('-to', String(endMs / 1000));
  args.push('-i', input);
  args.push('-vf', `scale='min(${maxWidth},iw)':-2:flags=lanczos`);
  args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p');
  args.push('-c:a', 'aac', '-b:a', '128k');
  args.push('-movflags', '+faststart', output);
  return args;
}

/** Single jpeg frame at timeMs, used for the <video poster>. */
export function buildPosterArgs({
  input,
  timeMs,
  output
}: {
  input: string;
  timeMs: number;
  output: string;
}): string[] {
  return ['-ss', String(timeMs / 1000), '-i', input, '-vframes', '1', '-q:v', '2', output];
}

export interface VideoProbe {
  width: number;
  height: number;
  durationMs: number;
  codecVideo: string;
  codecAudio: string | null;
  format: string;
}

/** Parse `ffprobe -print_format json -show_streams -show_format` output. */
export function parseProbeJson(json: unknown): VideoProbe {
  const d = (json ?? {}) as {
    streams?: Array<Record<string, unknown>>;
    format?: Record<string, unknown>;
  };
  const streams = Array.isArray(d.streams) ? d.streams : [];
  const video = streams.find((s) => s.codec_type === 'video');
  if (
    video === undefined ||
    typeof video.width !== 'number' ||
    typeof video.height !== 'number' ||
    typeof video.codec_name !== 'string'
  ) {
    throw new Error('ffprobe: no video stream found');
  }
  const audio = streams.find((s) => s.codec_type === 'audio');
  const format = d.format ?? {};
  return {
    width: video.width,
    height: video.height,
    durationMs: Math.round(firstDuration(video.duration, format.duration) * 1000),
    codecVideo: video.codec_name,
    codecAudio: typeof audio?.codec_name === 'string' ? audio.codec_name : null,
    format: typeof format.format_name === 'string' ? format.format_name : 'unknown'
  };
}

/** First usable duration in seconds; stream duration wins, format is the fallback. */
function firstDuration(...values: unknown[]): number {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

interface RunResult {
  stdout: string;
  stderr: string;
}

function runBinary(
  bin: string,
  args: string[],
  opts: { timeoutMs: number; captureStdout?: boolean }
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', opts.captureStdout ? 'pipe' : 'ignore', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    if (opts.captureStdout) {
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => (stdout += chunk));
    }
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => (stderr += chunk));

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      // Killing the shell can orphan a grandchild (e.g. sleep) that still holds
      // the stderr pipe write end; close our read ends so 'close' isn't delayed
      // until that grandchild exits.
      child.stdout?.destroy();
      child.stderr?.destroy();
    }, opts.timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') reject(new Error(`${bin} not found; install ffmpeg package`));
      else reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGKILL') {
        reject(new Error(`${bin} timed out after ${opts.timeoutMs}ms`));
      } else if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${bin} exited with code ${String(code)}: ${tail(stderr)}`));
      }
    });
  });
}

function tail(text: string): string {
  const t = text.trim();
  return t.length > 500 ? `…${t.slice(-500)}` : t;
}

/** Run ffmpeg to completion; rejects on non-zero exit, timeout, or ENOENT. */
export async function runFfmpeg(
  args: string[],
  { timeoutMs }: { timeoutMs: number }
): Promise<void> {
  await runBinary('ffmpeg', args, { timeoutMs });
}

/** Probe a video file for dimensions, duration, codecs, and container. */
export async function probeVideo(filePath: string): Promise<VideoProbe> {
  const { stdout } = await runBinary(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', filePath],
    { timeoutMs: PROBE_TIMEOUT_MS, captureStdout: true }
  );
  return parseProbeJson(JSON.parse(stdout));
}
