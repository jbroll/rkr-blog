---
name: rkr-theme-writing
description: Use when adding or editing a CSS theme in static/themes/ for rkr-blog. Triggers on any task that involves theme files, site appearance, header layout, typography overrides, or "make the X theme look like Y".
---

# rkr-theme-writing

## Core principle

**Use structural CSS vars in `:root` first. Write raw class overrides only when no var exists.**

All structural layout decisions (header direction, title size, border styles, main margin) are already
exposed as CSS custom properties in `default.css`. Override the var; don't re-target the class.

## The cascade

1. `base.css` — a11y + overflow primitives (never touch)
2. `themes/default.css` — full structural CSS + default look; **always loaded**
3. `themes/<name>.css` — your theme; layers on top, overrides only what differs

## Var-first rule (the one rule)

Before writing ANY raw selector override, check `docs/theming.md §Structural tokens` for a var that
controls it. If a var exists: set it in `:root`. If no var exists: add one to `default.css` and wire
it into the rule there, THEN set it in your theme.

```css
/* ❌ RAW OVERRIDE — don't do this when a var exists */
.rkr-site-head { text-align: center; padding: 2rem 1.5rem 1rem; }

/* ✅ VAR OVERRIDE — correct */
:root {
  --rkr-header-text-align: center;
  --rkr-head-padding: 2rem 1.5rem 1rem;
  --rkr-header-direction: column;
}
```

## When raw overrides ARE appropriate

Raw class overrides are fine only when the behaviour genuinely can't be expressed with a var:

| Case | Example |
|------|---------|
| Second border on an element (vars cover only one border) | Newsprint `border-top: 4px double` on `.rkr-site-head` |
| Pseudo-element content / effects | Terminal `body::before` scanline, `body { text-shadow }` |
| Layout not reachable via `main` margin | Tufte `.rkr-site-head-inner { margin-left: 8% }`, `article { margin-left: 0 }` |
| Per-element size tweak not worth a var | `.post-list time { font-size: 0.8rem }` |

## Lock-dark pattern

When a theme's aesthetic only works on dark backgrounds, add a light-mode override that forces the same
palette (otherwise the OS light/dark toggle will fight the theme):

```css
@media (prefers-color-scheme: light) {
  :root {
    --rkr-bg: #0c0f0c;
    --rkr-text: #33ff33;
    /* ... full palette repeated */
  }
}
```

Use this for: `terminal`, `dracula`, any theme where the colour scheme IS the theme.

## When to add a new structural var

If you find yourself writing the same raw override in multiple themes, that property needs a var.
Add it to `default.css :root` (with the current hardcoded value as the default), wire it into the
relevant rule, then set it in each theme. Update the `docs/theming.md §Structural tokens` table.

## Verification checklist

After editing any theme, smoke-test:
- [ ] `/` — index page, tag rail, post list layout
- [ ] `/:slug` — article header h1, blockquote, code blocks
- [ ] `/admin/posts` — admin table still readable
- [ ] `/admin/login` — login form still usable
- [ ] Mobile (≤640px) — no overflow, header stacks correctly
- [ ] Dark mode (if theme supports it) — colours invert cleanly
- [ ] `npm run test:coverage` — must not regress

## Common mistakes

| Mistake | Fix |
|---------|-----|
| Override `.rkr-site-head { border-bottom: 0 }` | Set `--rkr-foot-border: none` in `:root` |
| Duplicate `font-size` and `font-weight` on `.rkr-site-title` | Set `--rkr-title-size` / `--rkr-title-weight` |
| Tufte-style layout via raw `main { margin-left: 8% }` | Set `--rkr-main-margin-left: 8%` in `:root` |
| Italic headings via `article h2 { font-style: italic }` | Set `--rkr-h2-style: italic` in `:root` |
