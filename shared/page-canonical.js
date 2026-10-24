/**
 * One canonical rule for a page and its Markdown twin.
 *
 * The HTML page is the authority: whatever its own <link rel="canonical">
 * says is what every alternate representation (the /x.md twin, its Link
 * header, its front-matter) must repeat. Guessing from the request path is
 * what let twins drift: static directory pages (/blog/..., /sources/...)
 * answer 200 at both /x and /x/, so the path a twin happened to fetch said
 * nothing about which of the two the page declares.
 *
 * Plain JS so the edge handler, scripts and node:test suites import it
 * directly.
 */

const CANONICAL_LINK = /<link\b[^>]*\brel\s*=\s*["']?canonical["']?[^>]*>/i;
const HREF_ATTR = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const FIRST_PARTY_HOST = /(^|\.)worldmonitor\.app$/i;

/** The href of the first <link rel="canonical"> in an HTML document, or null. */
export function declaredHtmlCanonical(html) {
  if (typeof html !== 'string') return null;
  const head = html.slice(0, 200_000);
  const tag = head.match(CANONICAL_LINK);
  if (!tag) return null;
  const href = tag[0].match(HREF_ATTR);
  const value = href ? (href[1] ?? href[2] ?? href[3] ?? '').trim() : '';
  return value || null;
}

/**
 * The canonical URL for the page served at `pageUrl`.
 *
 * `declaredHref` is the page's own declared canonical. It is honoured when it
 * resolves to a first-party http(s) URL; otherwise (no tag, off-site, junk)
 * the page's own query-less URL is used. The result is always query-less and
 * fragment-less, on the page's origin.
 */
export function pageCanonicalUrl(pageUrl, declaredHref = null) {
  const page = new URL(pageUrl);
  if (declaredHref) {
    try {
      const declared = new URL(declaredHref, page);
      if ((declared.protocol === 'https:' || declared.protocol === 'http:') && FIRST_PARTY_HOST.test(declared.hostname)) {
        return `${page.origin}${declared.pathname}`;
      }
    } catch {
      // fall through to the page's own URL
    }
  }
  return `${page.origin}${page.pathname}`;
}
