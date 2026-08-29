// Custom TipTap video node (video spec Task 8). One self-hosted mp4 per
// ::video directive; renders a <video> preview in the editor with a
// popover for trim / poster / caption. Serializes to
// `::video{ids=... trim=... poster=...}` — see prose-markdown.ts
// emitVideo / parseVideoToEditorNode for the wire format.

import { mergeAttributes, Node } from '@tiptap/core';

import { buildVideoMapFromOpfs } from './video-map-opfs.ts';

export interface VideoNodeAttrs {
  ids: string | null;
  /** Author trim "start-end" in seconds, or null. */
  trim: string | null;
  /** Poster time in seconds, or null. */
  poster: string | null;
  caption: string | null;
  width: string | null;
  justify: string | null;
  controls: boolean;
  autoplay: boolean;
}

interface TrimOp {
  kind: 'trim';
  startMs: number;
  endMs: number;
}

export const VideoNode = Node.create({
  name: 'video',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      ids: { default: null },
      trim: { default: null },
      poster: { default: null },
      caption: { default: null },
      width: { default: null },
      justify: { default: null },
      controls: { default: true },
      autoplay: { default: false }
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-video]' }];
  },
  renderHTML({ HTMLAttributes }) {
    const attrs = HTMLAttributes as Partial<VideoNodeAttrs>;
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-video': 'true',
        'data-ids': attrs.ids ?? '',
        class: 'rkr-video-placeholder',
        contenteditable: 'false'
      }),
      ['video', { controls: '' }]
    ];
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement('div');
      dom.className = 'rkr-video-placeholder';
      dom.setAttribute('data-video', 'true');
      dom.contentEditable = 'false';

      const video = document.createElement('video');
      video.controls = true;
      video.preload = 'metadata';
      dom.appendChild(video);

      const popover = buildPopover(node.attrs as Partial<VideoNodeAttrs>, (attrs) => {
        const pos = getPos();
        if (pos === undefined) return;
        editor.chain().setNodeSelection(pos).updateAttributes('video', attrs).run();
      });
      dom.appendChild(popover);

      // Preview src/poster come from the OPFS video map — same cache
      // ophashes the server mints, so the editor preview matches the
      // published URLs. Fire-and-forget: an empty map renders a bare
      // placeholder (the ::video widget's missing-video comment in
      // prose previews).
      void refreshPreview(node.attrs as Partial<VideoNodeAttrs>, video);

      return {
        dom,
        update: (updatedNode) => {
          void refreshPreview(updatedNode.attrs as Partial<VideoNodeAttrs>, video);
          return true;
        }
      };
    };
  }
});

/** Resolve the derivative URLs for the node's attrs and point the
 * preview <video> at them. */
async function refreshPreview(
  attrs: Partial<VideoNodeAttrs>,
  video: HTMLVideoElement
): Promise<void> {
  const ids = attrs.ids ?? '';
  if (!/^[0-9a-f]{64}$/.test(ids)) {
    video.removeAttribute('src');
    video.removeAttribute('poster');
    return;
  }
  const map = await buildVideoMapFromOpfs();
  const src = map.get(ids);
  if (!src) {
    video.removeAttribute('src');
    video.removeAttribute('poster');
    return;
  }
  const ops = trimToOps(attrs.trim ?? '');
  const posterTimeMs = posterSecondsToMs(attrs.poster ?? '');
  const { videoUrl, posterUrl } = await src.urlFor(ops, posterTimeMs);
  video.src = videoUrl;
  video.poster = posterUrl;
}

/** "2.0-45.5" (seconds) -> trim op; null when absent/malformed. */
function trimToOps(trim: string): TrimOp[] {
  const m = /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/.exec(trim.trim());
  if (!m) return [];
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return [];
  return [{ kind: 'trim', startMs: Math.round(start * 1000), endMs: Math.round(end * 1000) }];
}

/** Seconds string -> ms; the sidecar's poster time (0) when absent. */
function posterSecondsToMs(poster: string): number {
  if (poster.trim() === '') return 0;
  const n = Number(poster);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : 0;
}

/** Popover with number inputs (step 0.1s) for trim start/end, poster,
 * and a caption text input. Commits write the node attrs. */
function buildPopover(
  attrs: Partial<VideoNodeAttrs>,
  updateAttributes: (a: Record<string, unknown>) => void
): HTMLElement {
  const popover = document.createElement('details');
  popover.className = 'rkr-video-edit';
  const summary = document.createElement('summary');
  summary.textContent = 'Edit video';
  popover.appendChild(summary);

  const [start, end] = splitTrim(attrs.trim ?? '');
  const fields: Array<[string, string, string]> = [
    ['trimStart', 'Trim start (s)', start],
    ['trimEnd', 'Trim end (s)', end],
    ['poster', 'Poster (s)', attrs.poster ?? '']
  ];
  const inputs: Record<string, HTMLInputElement> = {};

  for (const [key, label, value] of fields) {
    const row = document.createElement('label');
    row.className = 'rkr-video-edit-row';
    row.textContent = label;
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.1';
    input.min = '0';
    input.value = value;
    row.appendChild(input);
    popover.appendChild(row);
    inputs[key] = input;
  }

  const captionRow = document.createElement('label');
  captionRow.className = 'rkr-video-edit-row';
  captionRow.textContent = 'Caption';
  const caption = document.createElement('input');
  caption.type = 'text';
  caption.value = attrs.caption ?? '';
  captionRow.appendChild(caption);
  popover.appendChild(captionRow);

  const commit = (): void => {
    const next: Record<string, unknown> = {
      trim: joinTrim(inputs.trimStart?.value ?? '', inputs.trimEnd?.value ?? ''),
      poster: inputs.poster?.value ?? '',
      caption: caption.value
    };
    updateAttributes(next);
  };
  for (const input of Object.values(inputs)) input.addEventListener('change', commit);
  caption.addEventListener('change', commit);

  return popover;
}

function splitTrim(trim: string): [string, string] {
  const m = /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/.exec(trim.trim());
  if (!m) return ['', ''];
  return [m[1] ?? '', m[2] ?? ''];
}

function joinTrim(start: string, end: string): string {
  if (start.trim() === '' || end.trim() === '') return '';
  return `${start}-${end}`;
}
