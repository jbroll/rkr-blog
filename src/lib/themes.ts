// Theme lookup: the active theme name, the bundled theme files, and the
// section theme names a band can use.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths, readPersistedSiteConfig, siteConfigWrites } from './config.ts';
import { THEME } from './grid.ts';

const VALID_THEME_NAME = /^[a-z][a-z0-9-]*$/;
const BUILT_IN_SECTION_THEMES = ['light', 'light-bold', 'dark', 'dark-bold'];
const SECTION_THEMES_DECL = /\/\*\s*rkr-section-themes:([^*]*)\*\//;

function repoThemesDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'static', 'themes');
}

/** The CSS file in `<site>/themes/` for a theme name, or null. */
export function siteThemeFile(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!VALID_THEME_NAME.test(name)) return null;
  const file = path.join(paths(env).themes, `${name}.css`);
  return fs.existsSync(file) ? file : null;
}

/** The CSS file for a theme name, or null when the name is unsafe or
 * no such theme exists. A site theme wins over a bundled one. */
export function themeFile(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!VALID_THEME_NAME.test(name)) return null;
  const site = siteThemeFile(name, env);
  if (site) return site;
  const file = path.join(repoThemesDir(), `${name}.css`);
  return fs.existsSync(file) ? file : null;
}

let resolved: { name: string; writes: number } | null = null;

function resolveThemeName(env: NodeJS.ProcessEnv): string {
  const requested = readPersistedSiteConfig(env).theme || env.SITE_THEME || 'default';
  if (!VALID_THEME_NAME.test(requested)) {
    process.stderr.write(
      `[rkroll] theme="${requested}" rejected (must match ${VALID_THEME_NAME.source}); using default\n`
    );
    return 'default';
  }
  if (!themeFile(requested, env)) {
    process.stderr.write(
      `[rkroll] theme="${requested}" not found in ${repoThemesDir()} or ${paths(env).themes}; using default\n`
    );
    return 'default';
  }
  return requested;
}

/** Active theme name. Precedence: `config/site.json#theme` > SITE_THEME
 * env > `default`. Unknown or invalid names fall back to default with a
 * one-shot stderr warning. Memoised until the next settings write. */
export function themeName(env: NodeJS.ProcessEnv = process.env): string {
  const writes = siteConfigWrites();
  if (resolved?.writes !== writes) resolved = { name: resolveThemeName(env), writes };
  return resolved.name;
}

function cssNames(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.css'))
    .map((f) => f.slice(0, -'.css'.length))
    .filter((n) => VALID_THEME_NAME.test(n));
}

/** Bundled and site themes, `default` first and the rest sorted. */
export function listAvailableThemes(env: NodeJS.ProcessEnv = process.env): string[] {
  const names = new Set([...cssNames(repoThemesDir()), ...cssNames(paths(env).themes)]);
  names.delete('default');
  return ['default', ...[...names].sort()];
}

/** Reset the memoised theme. Tests only. */
export function _resetThemeNameCache(): void {
  resolved = null;
}

/** Extra section theme names a theme declares in one comment line:
 * `/* rkr-section-themes: forest, sand *\/`. */
export function sectionThemeNames(css: string): string[] {
  const decl = SECTION_THEMES_DECL.exec(css)?.[1] ?? '';
  return decl
    .split(',')
    .map((n) => n.trim())
    .filter((n) => THEME.test(n));
}

/** Section themes a band can use with the active theme: the four
 * built-ins, then the theme's declared names. */
export function activeSectionThemes(env: NodeJS.ProcessEnv = process.env): string[] {
  const file = themeFile(themeName(env), env);
  /* c8 ignore next -- themeName only returns names whose file exists */
  const extra = file ? sectionThemeNames(fs.readFileSync(file, 'utf8')) : [];
  return [...new Set([...BUILT_IN_SECTION_THEMES, ...extra])];
}
