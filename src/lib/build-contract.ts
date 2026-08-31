// Names shared by the admin shell, the browser bundle, and the drain
// routes. Kept free of node builtins so the admin build can import
// them — client-build.ts, which resolves the server's own hash,
// cannot cross that line.

/** The shell's `<meta>` name, emitted by src/templates/admin.ts and
 * read by src/admin/build-id.ts. A rename in one place alone would
 * silently disable the staleness guard. */
export const BUILD_META_NAME = 'rkr-build';

export const BUILD_HEADER = 'x-rkr-build';

/** 426 Upgrade Required, not 409: `/admin/posts` already spends 409
 * on post-superseded and the client branches on it. */
export const STALE_CLIENT_STATUS = 426;
