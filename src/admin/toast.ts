// Transient bottom-right toast notification. Used by save.ts to give
// the author obvious feedback on a successful save (the existing
// #rkroll-admin-status line is small + muted and easy to miss).
//
// Self-contained: the module injects its own stylesheet on first
// use, owns its DOM container, and stacks toasts so back-to-back
// fires don't clobber each other. Auto-dismiss after 4s; manual
// close via the × button.

const STACK_ID = 'rkr-toast-stack';
const STYLE_ID = 'rkr-toast-style';
const DEFAULT_TTL_MS = 4000;
const FADE_MS = 200;

interface ToastAction {
  href: string;
  label: string;
}

export interface ToastOpts {
  kind?: 'success' | 'info' | 'error';
  text: string;
  action?: ToastAction;
  /** Override the auto-dismiss window. Pass Infinity to disable. */
  ttlMs?: number;
}

const TIMERS = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  // CSS lives here (not in admin-styles.ts) so this module stays
  // self-contained — drop the toast usage and nothing else needs
  // to change.
  s.textContent = `
#rkr-toast-stack { position: fixed; bottom: 1rem; right: 1rem; z-index: 1000; display: flex; flex-direction: column; gap: .5rem; pointer-events: none; max-width: min(360px, calc(100vw - 2rem)); }
.rkr-toast { pointer-events: auto; display: flex; align-items: center; gap: .75rem; background: var(--rkr-bg, #fff); color: var(--rkr-text, #222); border-radius: 6px; padding: .5rem .75rem; box-shadow: 0 4px 12px rgba(0,0,0,.15); border-left: 3px solid var(--rkr-muted, #888); opacity: 0; transform: translateY(8px); transition: opacity ${FADE_MS}ms ease-out, transform ${FADE_MS}ms ease-out; }
.rkr-toast.is-visible { opacity: 1; transform: translateY(0); }
.rkr-toast.is-success { border-left-color: #2ea44f; }
.rkr-toast.is-error { border-left-color: #cf222e; }
.rkr-toast-text { flex: 1; min-width: 0; word-break: break-word; }
.rkr-toast-action { color: var(--rkr-link, #1a4f7f); text-decoration: none; white-space: nowrap; }
.rkr-toast-action:hover { text-decoration: underline; }
.rkr-toast-close { background: none; border: none; cursor: pointer; font-size: 1.2rem; line-height: 1; color: var(--rkr-muted, #888); padding: 0 .25rem; }
.rkr-toast-close:hover { color: var(--rkr-text, #222); }
@media (prefers-reduced-motion: reduce) { .rkr-toast { transition: none; transform: none; } }
`;
  document.head.appendChild(s);
}

function ensureStack(): HTMLElement {
  let stack = document.getElementById(STACK_ID);
  if (!stack) {
    ensureStyle();
    stack = document.createElement('div');
    stack.id = STACK_ID;
    // aria-live=polite so screen readers announce without
    // interrupting; non-atomic so each toast reads on its own.
    stack.setAttribute('aria-live', 'polite');
    stack.setAttribute('aria-atomic', 'false');
    document.body.appendChild(stack);
  }
  return stack;
}

function dismiss(toast: HTMLElement): void {
  const timer = TIMERS.get(toast);
  if (timer) {
    clearTimeout(timer);
    TIMERS.delete(toast);
  }
  toast.classList.remove('is-visible');
  // Remove after fade. Safety setTimeout in case transitionend
  // doesn't fire (reduced-motion users, etc.).
  setTimeout(() => toast.remove(), FADE_MS + 50);
}

/** Show a transient toast. Returns a handle whose .dismiss() can
 * close it early. */
export function showToast(opts: ToastOpts): { dismiss: () => void } {
  const stack = ensureStack();
  const toast = document.createElement('div');
  toast.className = `rkr-toast is-${opts.kind ?? 'info'}`;
  toast.setAttribute('role', 'status');

  const text = document.createElement('span');
  text.className = 'rkr-toast-text';
  text.textContent = opts.text;
  toast.appendChild(text);

  if (opts.action) {
    const a = document.createElement('a');
    a.className = 'rkr-toast-action';
    a.href = opts.action.href;
    a.textContent = opts.action.label;
    toast.appendChild(a);
  }

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'rkr-toast-close';
  closeBtn.setAttribute('aria-label', 'Dismiss notification');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => dismiss(toast));
  toast.appendChild(closeBtn);

  stack.appendChild(toast);
  // Defer the visible-class flip to the next frame so the CSS
  // transition runs (browsers don't transition on initial paint).
  requestAnimationFrame(() => toast.classList.add('is-visible'));

  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  if (Number.isFinite(ttl)) {
    const timer = setTimeout(() => dismiss(toast), ttl);
    TIMERS.set(toast, timer);
  }

  return { dismiss: () => dismiss(toast) };
}
