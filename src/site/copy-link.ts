// Post-header "Copy link" button. Writes the current URL to the
// clipboard so a reader can share the canonical post link without
// fishing it out of the address bar. The button itself is rendered
// by src/templates/post.ts; this script just wires the click. Brief
// visual feedback via a data-state attribute the stylesheet keys on.

const btn = document.querySelector<HTMLButtonElement>('.rkr-post-copylink');
if (btn) {
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      flash(btn, 'copied');
    } catch {
      /* c8 ignore next 3 -- runtime-only failure path (permission
         denied / unsupported); flash an error state so the reader
         sees the click registered before falling back to manual copy. */
      flash(btn, 'error');
    }
  });
}

function flash(el: HTMLButtonElement, state: 'copied' | 'error'): void {
  el.dataset.state = state;
  window.setTimeout(() => {
    if (el.dataset.state === state) delete el.dataset.state;
  }, 1500);
}
