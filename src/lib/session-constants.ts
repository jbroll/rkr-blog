// Shared session constants used by both lib (auth-middleware) and routes.
// Lives in lib so that middleware never imports from routes.

/** Cookie name used to store the session ID. */
export const SESSION_COOKIE_NAME = 'rkr_session';
