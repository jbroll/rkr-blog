// ::video directive emit/parse for the admin editor's prose converter.
// Kept out of prose-markdown.ts (which is at its size cap); the two
// sides stay symmetrical with the figure directive: quoted attributes
// (ids/trim/poster/caption) ride through quote()/directiveDecode from
// prose-markdown.ts, unquoted ones (width/justify + the boolean flags)
// pass through verbatim.

import { directiveDecode, quote } from './directive-encoding.ts';

/** The `video` ProseMirror node parseVideoToEditorNode produces —
 * structurally assignable to prose-markdown.ts's ProseNode. Declared
 * locally so this module doesn't import prose-markdown.ts (which would
 * create an import cycle with prose-markdown.ts's import of this file). */
interface VideoProseNode {
  type: 'video';
  attrs: Record<string, unknown>;
}

/**
 * Emit a `::video{...}` directive. Mirrors emitFigure: only attributes
 * whose values differ from the widget defaults are emitted so the
 * round-trip stays minimal.
 */
export function emitVideo(attrs: Record<string, unknown>): string {
  const idsRaw = attrs.ids;
  const ids = typeof idsRaw === 'string' ? idsRaw : Array.isArray(idsRaw) ? idsRaw.join(',') : '';
  if (!ids.trim()) return '';

  const parts: string[] = [`ids=${quote(ids)}`];

  const trim = attrs.trim;
  if (typeof trim === 'string' && trim.length > 0) {
    parts.push(`trim=${quote(trim)}`);
  }

  const poster = attrs.poster;
  if (typeof poster === 'string' && poster.length > 0) {
    parts.push(`poster=${quote(poster)}`);
  }

  const caption = attrs.caption;
  if (typeof caption === 'string' && caption.length > 0) {
    parts.push(`caption=${quote(caption)}`);
  }

  const width = attrs.width;
  if (typeof width === 'string' && /^\d+(px|%)$/.test(width)) {
    parts.push(`width=${width}`);
  }

  const justify = attrs.justify;
  if (typeof justify === 'string' && justify.length > 0 && justify !== 'center') {
    parts.push(`justify=${justify}`);
  }

  if (attrs.controls === false) parts.push('controls=false');
  if (attrs.autoplay === true) parts.push('autoplay');
  if (attrs.muted === true) parts.push('muted');
  if (attrs.loop === true) parts.push('loop');

  return `::video{${parts.join(' ')}}`;
}

/**
 * Parse a `::video{...}` directive's attributes into the `video`
 * ProseMirror node. Mirrors parseFigureToEditorNode: the four quoted
 * attributes (ids/trim/poster/caption) are directiveDecode'd so the
 * editor model is byte-identical after a save round trip; the boolean
 * flags parse from their unquoted directive forms.
 */
export function parseVideoToEditorNode(
  attrs: Record<string, string | null | undefined>
): VideoProseNode {
  return {
    type: 'video',
    attrs: {
      ids: directiveDecode(attrs.ids ?? ''),
      trim: directiveDecode(attrs.trim ?? ''),
      poster: directiveDecode(attrs.poster ?? ''),
      caption: directiveDecode(attrs.caption ?? ''),
      width: attrs.width ?? '',
      justify: attrs.justify ?? 'center',
      controls: attrs.controls !== 'false',
      autoplay: attrs.autoplay === '' || attrs.autoplay === 'true' || attrs.autoplay === '1',
      muted: attrs.muted === '' || attrs.muted === 'true' || attrs.muted === '1',
      loop: attrs.loop === '' || attrs.loop === 'true' || attrs.loop === '1'
    }
  };
}
