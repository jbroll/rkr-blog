// `::video` directive widget (video spec §5). One self-hosted mp4 per
// ::video, addressed through the VideoMap; renders a <figure
// class="rkr-video"> shell with an aspect-reserving wrapper and a
// <video> element pointed at the derivative URLs. Pure string work —
// no FS, no ffmpeg, no DOM.

import { escapeAttr, escapeText } from '../lib/content.ts';
import type {
  DirectiveNode,
  FallbackSpec,
  VariantSpec,
  Widget,
  WidgetCtx
} from '../lib/widgets.ts';
import { validateVideoAttrs } from './video-attrs.ts';

const name = 'video';

/** Trim op as the VideoMap's urlFor expects it. Defined locally so this
 * browser-compiled widget stays free of the node-dependent sidecar
 * module (structurally identical to lib/video-sidecar.ts VideoOp). */
interface TrimOp {
  kind: 'trim';
  startMs: number;
  endMs: number;
}

// Declared for parity with the figure widget and future constants-
// alignment checks. urlFor in the VideoMap bakes these widths into the
// cache ophashes, so the renderer never recomputes them.
export const variants: VariantSpec[] = [{ w: 1920, formats: ['mp4'] }];
export const poster = { w: 640, format: 'jpg' };
export const fallback: FallbackSpec = { w: 640, format: 'jpg', quality: 85 };

function render(node: DirectiveNode, ctx: WidgetCtx): string {
  const v = validateVideoAttrs(node.attributes ?? {});
  if (!v.ok) return `<!-- invalid video widget: ${v.error} -->`;
  const a = v.attrs;

  const src = ctx.videos.get(a.ids);
  if (!src) return `<!-- missing video: ${a.ids} -->`;

  // Trim range vs the probe duration: start < end is validated at parse
  // time (no duration there); the upper bound exists only here.
  let ops: TrimOp[] = [];
  if (a.trim) {
    if (a.trim.endMs > src.durationMs) {
      return `<!-- invalid video widget: trim end ${a.trim.endMs}ms beyond duration ${src.durationMs}ms -->`;
    }
    ops = [{ kind: 'trim', startMs: a.trim.startMs, endMs: a.trim.endMs }];
  }

  const posterTimeMs = a.poster ?? src.sidecar.poster.timeMs;
  const { videoUrl, posterUrl } = src.urlFor(ops, posterTimeMs);

  // Inline is a figure concept (text-flow <span>); a video can't sit in
  // text flow, so it degrades to the centered block placement.
  const justify = a.justify === 'inline' ? 'center' : a.justify;

  const styleParts: string[] = [];
  // Width only applies under left/right/center — same rule as figures.
  if (a.width && justify !== 'full' && justify !== 'bleed') {
    styleParts.push(`width: ${a.width}`);
  }
  const style = styleParts.length ? ` style="${styleParts.join('; ')}"` : '';

  const videoAttrs: string[] = [];
  if (a.controls) videoAttrs.push('controls');
  videoAttrs.push(`preload="metadata"`);
  videoAttrs.push(`poster="${escapeAttr(posterUrl)}"`);
  videoAttrs.push(`src="${escapeAttr(videoUrl)}"`);
  videoAttrs.push(`width="${src.width}" height="${src.height}"`);
  videoAttrs.push(`data-duration="${src.durationMs}"`);
  if (a.autoplay) videoAttrs.push('autoplay');
  // Autoplay is only allowed muted (browser policy); playsinline keeps
  // it from hijacking fullscreen on iOS.
  if (a.autoplay || a.muted) videoAttrs.push('muted');
  if (a.loop) videoAttrs.push('loop');
  if (a.autoplay) videoAttrs.push('playsinline');

  const captionBlock = a.caption
    ? `\n  <figcaption class="rkr-video-caption">${escapeText(a.caption)}</figcaption>`
    : '';

  return [
    `<figure class="rkr-video rkr-justify-${justify}"${style}>`,
    `  <div class="rkr-video-wrapper" style="--rkr-video-aspect: ${src.width}/${src.height}">`,
    `    <video ${videoAttrs.join(' ')}>`,
    '    </video>',
    '  </div>',
    `${captionBlock}\n</figure>`
  ].join('\n');
}

const widget: Widget = { name, variants, fallback, render };
export default widget;
