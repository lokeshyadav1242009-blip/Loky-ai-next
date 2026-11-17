/**
 * True when a request path looks like a static asset, i.e. its last segment
 * carries a file extension: /styles.css, /admin/app.js, /vendor/supabase.min.js.
 *
 * The SPA fallback must never answer these with index.html. Doing so handed the
 * browser HTML labelled `text/html` for a `.css`/`.js` URL; `X-Content-Type-Options:
 * nosniff` then refused it, so the page rendered unstyled and no module ran —
 * which is why the auth gate could sit on "Checking your session…" forever.
 * A 404 makes a wrong asset path obvious instead of looking like a broken UI.
 */
export function isAssetPath(requestPath) {
  if (typeof requestPath !== 'string' || requestPath === '') return false;
  const lastSegment = requestPath.slice(requestPath.lastIndexOf('/') + 1);
  return /\.[a-z0-9]+$/i.test(lastSegment);
}
