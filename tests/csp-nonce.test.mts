import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it, afterEach } from 'node:test';

import middleware, { config as middlewareConfig } from '../middleware.ts';
import {
  CSP_NONCE_PLACEHOLDER,
  CSP_RAW_REQUEST_HEADER,
  RETIRED_STATIC_SCRIPT_NONCE,
  STAMPED_DOCUMENT_CACHE_CONTROL,
  STAMPED_DOCUMENT_CDN_CACHE_CONTROL,
  attributeNonces,
  policyNonces,
  stampCspDocument,
} from '../shared/csp-nonce.mjs';

const ROOT = new URL('..', import.meta.url);
const POLICY = "default-src 'self'; script-src 'self' 'strict-dynamic' 'sha256-abc='";
const DOCUMENT = `<!doctype html><script nonce="${CSP_NONCE_PLACEHOLDER}" src="/a.js"></script><script nonce="${CSP_NONCE_PLACEHOLDER}">var ready = true;</script>`;

const HEADER_FILES = [
  'vercel.json',
  'docker/nginx.conf',
  'docker/nginx.conf.template',
  'docker/nginx-security-headers.conf',
  'docker/nginx-embed-security-headers.conf',
  'docker/nginx-oauth-authorize-security-headers.conf',
  'docker/nginx-youtube-embed-security-headers.conf',
];

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function read(path: string): string {
  return readFileSync(new URL(path, ROOT), 'utf8');
}

function nonceAgreement(html: string, policy: string): void {
  const bodyNonces = attributeNonces(html);
  const headerNonces = policyNonces(policy);
  assert.ok(bodyNonces.length > 0, 'response should carry a script nonce');
  assert.deepEqual(headerNonces, [bodyNonces[0]]);
  assert.ok(bodyNonces.every((nonce) => nonce === headerNonces[0]));
  assert.equal(html.includes(CSP_NONCE_PLACEHOLDER), false);
  assert.equal(policy.includes(CSP_NONCE_PLACEHOLDER), false);
  assert.equal(policy.includes(RETIRED_STATIC_SCRIPT_NONCE), false);
}

describe('per-response CSP nonce', () => {
  it('stamps a fresh nonce that matches every script and differs across responses', () => {
    const first = stampCspDocument(DOCUMENT, POLICY);
    const second = stampCspDocument(DOCUMENT, POLICY);
    assert.ok(first && second);
    nonceAgreement(first.html, first.policy);
    nonceAgreement(second.html, second.policy);
    assert.notEqual(first.nonce, second.nonce);
    assert.match(first.policy, /script-src 'nonce-[^']+' 'self' 'strict-dynamic'/);
  });

  it('leaves the retired static nonce only in the shared constant', () => {
    let hits: string[] = [];
    try {
      hits = execFileSync('rg', [
        '-l',
        '--fixed-strings',
        '--glob', '!node_modules/**',
        '--glob', '!**/node_modules/**',
        '--glob', '!dist/**',
        '--glob', '!.git/**',
        RETIRED_STATIC_SCRIPT_NONCE,
        '.',
      ], { cwd: new URL('.', ROOT), encoding: 'utf8' }).trim().split('\n');
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 1) throw error;
    }
    assert.deepEqual(hits, ['./shared/csp-nonce.mjs']);
  });

  it('committed CSP headers do not allow the placeholder or the retired nonce', () => {
    const forbidden = [
      `'nonce-${RETIRED_STATIC_SCRIPT_NONCE}'`,
      `'nonce-${CSP_NONCE_PLACEHOLDER}'`,
    ];
    for (const file of HEADER_FILES) {
      const text = read(file);
      for (const token of forbidden) {
        assert.equal(text.includes(token), false, `${file} still allows ${token}`);
      }
    }
    const vercel = read('vercel.json');
    assert.equal(vercel.includes("'nonce-"), false, 'vercel.json must not ship a static script nonce');
    for (const file of ['docker/nginx.conf', 'docker/nginx-security-headers.conf']) {
      assert.match(read(file), /script-src 'self' 'strict-dynamic' 'nonce-\$request_id'/);
    }
    for (const file of ['docker/nginx.conf', 'docker/nginx.conf.template']) {
      const text = read(file);
      assert.match(text, new RegExp(`sub_filter '${CSP_NONCE_PLACEHOLDER}' '\\$request_id';`));
      assert.match(text, /sub_filter_once off;/);
    }
    assert.match(read('docker/nginx.conf'), /gzip_static off;/);
  });

  it('matches html documents in middleware and leaves hashed assets alone', () => {
    const routeMatcher = middlewareConfig.matcher.find((matcher) => matcher.startsWith('/((?!'));
    assert.ok(routeMatcher);
    const routeRegex = new RegExp(`^${routeMatcher}$`);
    for (const path of ['/', '/dashboard', '/settings.html', '/pro/index.html', '/blog/post']) {
      assert.match(path, routeRegex, path);
    }
    for (const path of ['/assets/app.js', '/assets/app.css', '/api/health', '/favicon.ico']) {
      assert.doesNotMatch(path, routeRegex, path);
    }
  });

  it('middleware responses agree on the nonce, differ, and are not cached', async () => {
    globalThis.fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get(CSP_RAW_REQUEST_HEADER), '1');
      return new Response(DOCUMENT, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', etag: '"built"' },
      });
    };
    const request = () => new Request('https://www.worldmonitor.app/dashboard', {
      headers: { accept: 'text/html' },
    });
    const first = await middleware(request());
    const second = await middleware(request());
    assert.ok(first instanceof Response && second instanceof Response);
    const firstHtml = await first.text();
    const secondHtml = await second.text();
    const firstPolicy = first.headers.get('content-security-policy') ?? '';
    const secondPolicy = second.headers.get('content-security-policy') ?? '';
    nonceAgreement(firstHtml, firstPolicy);
    nonceAgreement(secondHtml, secondPolicy);
    assert.notEqual(policyNonces(firstPolicy)[0], policyNonces(secondPolicy)[0]);
    assert.equal(first.headers.get('cache-control'), STAMPED_DOCUMENT_CACHE_CONTROL);
    assert.equal(first.headers.get('cdn-cache-control'), STAMPED_DOCUMENT_CDN_CACHE_CONTROL);
    assert.equal(first.headers.get('vercel-cdn-cache-control'), STAMPED_DOCUMENT_CDN_CACHE_CONTROL);
    assert.equal(first.headers.get('etag'), null);
  });

  it('does not stamp a platform redirect or a raw inner fetch', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(null, { status: 308, headers: { location: '/dashboard' } });
    };
    assert.equal(await middleware(new Request('https://tech.worldmonitor.app/', {
      headers: { accept: 'text/html' },
    })), undefined);
    assert.equal(calls, 1);

    calls = 0;
    assert.equal(await middleware(new Request('https://www.worldmonitor.app/settings.html', {
      headers: { accept: 'text/html', [CSP_RAW_REQUEST_HEADER]: '1' },
    })), undefined);
    assert.equal(calls, 0);
  });
});
