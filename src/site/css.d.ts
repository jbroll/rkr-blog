// Side-effect CSS imports (e.g. `import 'photoswipe/style.css'`).
// Esbuild bundles the CSS into the adjacent .css output (lightbox.css);
// TS just needs to know the module name resolves.
declare module '*.css';
