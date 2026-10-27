// Leaf blocks without widget dispatch: markdown text, button, marquee,
// accordion, progress and embed.

import { remark } from 'remark';
import remarkDirective from 'remark-directive';
import type { Slots } from './blocks.ts';
import { escapeAttr, escapeText, type RenderCtx, renderPostHtml } from './content.ts';
import { embedAllowed } from './embed-allow.ts';
import { safeLinkUrl } from './safe-url.ts';
import type { Campaign } from './site-org-settings.ts';

const MARQUEE_MIN_CHARS = 200;
const EMBED_HEIGHT = { min: 150, max: 2000 };

export function textOf(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

export function renderMarkdown(md: string, ctx: RenderCtx): Promise<string> {
  const ast = remark().use(remarkDirective).parse(md);
  return renderPostHtml(ast as Parameters<typeof renderPostHtml>[0], ctx);
}

/** `marked` keeps an empty element for the editor to select. */
export function renderButton(slots: Slots | undefined, marked: boolean): string {
  const label = textOf(slots?.label);
  // Readers get no empty pill; the editor needs an element to select.
  if (!label.trim() && !marked) return '';
  const href = safeLinkUrl(textOf(slots?.href, '#'));
  const variant = textOf(slots?.variant, 'primary') === 'secondary' ? 'secondary' : 'primary';
  const large = textOf(slots?.size) === 'large' ? ' is-large' : '';
  const arrow =
    slots?.arrow === true ? '<span class="rkr-btn-arrow" aria-hidden="true">→</span>' : '';
  return `<a class="rkr-btn is-${variant}${large}" href="${escapeAttr(href)}">${escapeText(label)}${arrow}</a>\n`;
}

export function renderMarquee(slots: Slots | undefined, marked: boolean): string {
  const text = textOf(slots?.text).trim();
  if (!text) return marked ? '<div class="rkr-marquee"></div>\n' : '';
  const copies = Math.max(2, Math.ceil((MARQUEE_MIN_CHARS + 1) / (text.length + 1)));
  const half = escapeText(Array(copies).fill(text).join(' '));
  return `<div class="rkr-marquee"><span>${half}</span><span aria-hidden="true">${half}</span></div>\n`;
}

export async function renderAccordion(slots: Slots | undefined, ctx: RenderCtx): Promise<string> {
  const items = Array.isArray(slots?.items) ? slots.items : [];
  const out = await Promise.all(
    items.map(async (it) => {
      const rec = (it ?? {}) as Record<string, unknown>;
      const body = await renderMarkdown(textOf(rec.body), ctx);
      return `<details><summary>${escapeText(textOf(rec.title))}</summary>\n${body}</details>`;
    })
  );
  return `<div class="rkr-accordion">\n${out.join('\n')}\n</div>\n`;
}

const count = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const figure = (n: number): string => n.toLocaleString('en-US');

export function renderProgress(slots: Slots | undefined, campaign: Campaign | undefined): string {
  const fromSite = slots?.source === 'site';
  const goal = count(fromSite ? campaign?.goal : slots?.goal);
  const raised = count(fromSite ? campaign?.raised : slots?.raised);
  const pct = goal > 0 ? Math.min(100, Math.round((raised / goal) * 100)) : 0;
  const bar = `<div class="rkr-progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div class="rkr-progress-bar" style="width: ${pct}%"></div></div>\n`;
  if (!(goal > 0)) return bar;
  return `${bar}<p class="rkr-progress-figures"><span class="rkr-progress-raised">${figure(raised)}</span> of <span class="rkr-progress-goal">${figure(goal)}</span></p>\n`;
}

function embedHeight(v: unknown): string {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isFinite(n)) return '';
  const h = Math.max(EMBED_HEIGHT.min, Math.min(EMBED_HEIGHT.max, Math.round(n)));
  return ` style="height:${h}px"`;
}

export function renderEmbed(slots: Slots | undefined): string {
  const url = textOf(slots?.url);
  try {
    new URL(url);
  } catch {
    return '<!-- embed: invalid url -->';
  }
  if (!embedAllowed(url)) {
    return `<a href="${escapeAttr(safeLinkUrl(url))}">${escapeText(url)}</a>\n`;
  }
  return `<iframe class="rkr-embed" src="${escapeAttr(url)}" loading="lazy"${embedHeight(slots?.height)} sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>\n`;
}
