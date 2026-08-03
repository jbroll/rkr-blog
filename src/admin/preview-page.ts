// /admin/view/:slug — the current buffer rendered as the published
// page. Client-side even when online: a server render would show the
// last saved version, so online and offline would disagree.

import { parsePost, renderPostHtml } from '../lib/content.ts';
import { type ProseDoc, proseToMarkdown } from '../lib/prose-markdown.ts';
import { WidgetRegistry } from '../lib/widgets.ts';
import type { AssetCtx } from '../templates/layout.ts';
import { renderPostPage } from '../templates/post.ts';
import figureWidget from '../widgets/figure.ts';
import { loadDraft, readMeta } from './draft.ts';
import { buildImageMapFromOpfs } from './image-map-opfs.ts';
import { listDir } from './opfs.ts';
import { isDraftMetaFile, OPFS_DIRS, readRoot } from './opfs-schema.ts';
import { readSiteSnapshot, type SiteSnapshot } from './site-snapshot.ts';

const ASSET_BASE = '/admin/static';

export interface PreviewInput {
  slug: string;
  title: string;
  subtitle?: string;
  date?: string;
  markdown: string;
  snapshot: SiteSnapshot | null;
}

function assetsFrom(snapshot: SiteSnapshot | null): AssetCtx {
  return {
    theme: snapshot?.theme ?? 'default',
    hash: snapshot?.hash ?? 'unknown',
    base: ASSET_BASE
  };
}

export async function renderPreviewDocument(input: PreviewInput): Promise<string> {
  const widgets = new WidgetRegistry();
  widgets.register(figureWidget);
  const images = await buildImageMapFromOpfs(input.markdown);
  const parsed = parsePost(
    `---\ntitle: ${JSON.stringify(input.title)}\nslug: ${JSON.stringify(input.slug)}\n---\n\n${input.markdown}`
  );
  const bodyHtml = await renderPostHtml(parsed.ast, { images, widgets });

  return renderPostPage({
    site: {
      title: input.snapshot?.title ?? input.title,
      ...(input.snapshot?.tagline ? { tagline: input.snapshot.tagline } : {})
    },
    assets: assetsFrom(input.snapshot),
    title: input.title,
    ...(input.subtitle ? { subtitle: input.subtitle } : {}),
    slug: input.slug,
    ...(input.date ? { date: input.date } : {}),
    bodyHtml,
    isAdmin: true,
    // The thread is server data pinning doesn't pull; fetching it would
    // extend the post-bundle manifest.
    showComments: false,
    scripts: false
  });
}

/** Build the preview input for one draft, or null if its slug doesn't
 * match or it has no body yet. */
async function previewInputFor(draftId: string, slug: string): Promise<PreviewInput | null> {
  const meta = await readMeta(draftId);
  if (meta?.slug !== slug) return null;
  const doc = (await loadDraft(draftId)) as ProseDoc | null;
  if (!doc) return null;
  return {
    slug,
    title: meta.title || slug,
    ...(meta.subtitle ? { subtitle: meta.subtitle } : {}),
    ...(meta.date ? { date: meta.date } : {}),
    markdown: proseToMarkdown(doc),
    snapshot: await readSiteSnapshot()
  };
}

/** Find the draft holding this slug: the active one first — so two
 * metas claiming the same slug (a pinned copy alongside an in-
 * progress local draft) can't show the stale one — then any other
 * meta that claims it. */
export async function findMarkdown(slug: string): Promise<PreviewInput | null> {
  const currentDraftId = (await readRoot())?.currentDraftId;
  if (currentDraftId) {
    const active = await previewInputFor(currentDraftId, slug);
    if (active) return active;
  }
  for (const fname of await listDir(OPFS_DIRS.META)) {
    if (!isDraftMetaFile(fname)) continue;
    const draftId = fname.slice(0, -5);
    if (draftId === currentDraftId) continue;
    const found = await previewInputFor(draftId, slug);
    if (found) return found;
  }
  return null;
}

export async function bootPreview(): Promise<void> {
  const slug = decodeURIComponent(location.pathname.replace(/^\/admin\/view\//, ''));
  const input = await findMarkdown(slug);
  if (!input) {
    document.body.textContent = `No local copy of "${slug}". Pin it while online first.`;
    return;
  }
  const html = await renderPreviewDocument(input);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Swap the whole head: the shell's admin <style> block would
  // otherwise override the published layout it was written to frame.
  document.head.replaceChildren();
  for (const el of [...doc.head.children]) document.head.appendChild(document.importNode(el, true));
  document.body.replaceChildren();
  for (const el of [...doc.body.children]) document.body.appendChild(document.importNode(el, true));
}
