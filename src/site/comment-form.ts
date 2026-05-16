// Progressive enhancement for the comment form. The form works fully
// without JS (native POST → 303 PRG redirect; see public-comments.ts).
// This intercepts the submit, posts via fetch, and swaps the success
// notice in place — no full-page navigation, so no flicker. Loaded as a
// separate <script src> module to stay under the strict
// `script-src 'self'` CSP (no inline JS), same pattern as sw-register.
//
// Any failure (network error, non-OK response, no fetch) falls straight
// back to a native form submit, so the no-JS PRG path is the safety net
// and behaviour never regresses for users where the enhancement can't run.

const form = document.querySelector<HTMLFormElement>('form.rkr-comment-form');
const respond = document.getElementById('respond');

if (form && respond) {
  let submitting = false;

  form.addEventListener('submit', (e) => {
    if (submitting) return;
    e.preventDefault();
    submitting = true;

    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (button) button.disabled = true;

    const params = new URLSearchParams();
    for (const [k, v] of new FormData(form)) params.append(k, String(v));

    fetch(form.action, {
      method: 'POST',
      headers: { 'x-rkr-ajax': '1', 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    })
      .then(async (res) => {
        const data = res.ok ? ((await res.json()) as { ok?: boolean; notice?: string }) : null;
        if (!data?.ok) throw new Error('submit not accepted');

        // Mirror the PRG result: notice above the form, form reset.
        let notice = respond.querySelector<HTMLParagraphElement>('.rkr-comment-notice');
        if (!notice) {
          notice = document.createElement('p');
          notice.className = 'rkr-comment-notice';
          notice.setAttribute('role', 'status');
          form.before(notice);
        }
        notice.textContent = data.notice ?? 'Thanks — your comment has been received.';
        form.reset();
        if (button) button.disabled = false;
        submitting = false;
        notice.scrollIntoView({ block: 'center' });
      })
      .catch(() => {
        // Enhancement failed — let the browser do the real submit so the
        // user still gets the no-JS PRG flow (success page or error).
        submitting = false;
        form.submit();
      });
  });
}
