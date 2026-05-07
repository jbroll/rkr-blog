// Side-effect CSS imports (e.g. `import 'cropperjs/dist/cropper.css'`).
// Esbuild bundles the CSS into static/admin/main.css; TS just needs to
// know the module name resolves.
declare module '*.css';
