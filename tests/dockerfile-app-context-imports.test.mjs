// Static guard: docker/Dockerfile runs `npx tsc && npx vite build` on a
// `COPY . .` of the build context, and .dockerignore drops `tests`, `e2e`,
// docs and friends from that context. A file tsc type-checks (tsconfig.json
// `include`) that imports a path .dockerignore excludes compiles everywhere
// except inside the image build — and that build only runs when a release is
// published, so the break surfaces after the merge, at release time.
//
// Historical failure this test would have caught:
// - 2026-10-19: #9391 added src/e2e/country-qualified-signals-harness.ts
//   importing tests/fixtures/qualified-country-signals; v2.11.1's
//   "Publish Docker image" failed with TS2307 and no image shipped.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStrippedSource, relativeToRepoRoot, resolveTsxRelative } from './_lib/import-graph-walk.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// .dockerignore rules in file order; the last matching rule wins, and a
// pattern that matches a directory excludes everything beneath it.
export function parseDockerignore(src) {
  return src.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((line) => {
    const negate = line.startsWith('!');
    const pattern = (negate ? line.slice(1) : line).replace(/^\/+/, '').replace(/\/+$/, '');
    const re = pattern.split('/').map((seg) => (seg === '**' ? '.*' : seg
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]'))).join('/');
    return { negate, re: new RegExp(`^${re}$`) };
  });
}

export function isExcluded(rules, relPath) {
  const parts = relPath.split('/');
  let excluded = false;
  for (const { negate, re } of rules) {
    for (let i = 1; i <= parts.length; i++) {
      if (re.test(parts.slice(0, i).join('/'))) { excluded = !negate; break; }
    }
  }
  return excluded;
}

// Every relative specifier tsc resolves, including `import type` and
// type-only `export ... from`, which tsx erases but tsc still type-checks.
function relativeSpecs(file) {
  const src = readStrippedSource(file);
  const specs = new Set();
  for (const re of [/\bfrom\s*['"]([^'"]+)['"]/g, /(?:^|;)[ \t]*import\s*['"]([^'"]+)['"]/gm, /\bimport\(\s*['"]([^'"]+)['"]/g]) {
    for (const m of src.matchAll(re)) if (m[1].startsWith('.')) specs.add(m[1]);
  }
  return specs;
}

function listSources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) listSources(p, out);
    else if (/\.(ts|tsx|mts)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

describe('docker/Dockerfile — tsc inputs stay inside the build context', () => {
  const rules = parseDockerignore(readFileSync(resolve(root, '.dockerignore'), 'utf-8'));
  const tsconfig = JSON.parse(readFileSync(resolve(root, 'tsconfig.json'), 'utf-8'));
  const excludedEntries = new Set((tsconfig.exclude ?? []).map((p) => resolve(root, p)));
  const files = tsconfig.include.flatMap((entry) => {
    const abs = resolve(root, entry);
    return statSync(abs).isDirectory() ? listSources(abs) : [abs];
  }).filter((f) => !excludedEntries.has(f));

  it('the matcher reads .dockerignore the way Docker does (sanity)', () => {
    assert.ok(files.length > 100, `expected the tsconfig include set to be large, got ${files.length}`);
    assert.equal(isExcluded(rules, 'tests/fixtures/qualified-country-signals.ts'), true);
    assert.equal(isExcluded(rules, 'e2e/runtime.spec.ts'), true);
    assert.equal(isExcluded(rules, 'src/e2e/country-qualified-signals-harness.ts'), false);
    assert.equal(isExcluded(rules, 'scripts/shared/comtrade.mjs'), false);
    assert.equal(isExcluded(rules, '.github/workflows/test.yml'), false);
    assert.equal(isExcluded(rules, '.github/CODEOWNERS'), true);
  });

  it('no type-checked file imports a path .dockerignore drops', () => {
    const offenders = [];
    for (const file of files) {
      for (const spec of relativeSpecs(file)) {
        const target = resolveTsxRelative(file, spec);
        if (!target) continue;
        const rel = relativeToRepoRoot(root, target);
        if (rel && isExcluded(rules, rel)) offenders.push(`${relativeToRepoRoot(root, file)} → ${rel}`);
      }
    }
    assert.deepEqual(offenders, [], 'these imports resolve locally but are missing from the Docker build context; move the target under src/ or shared/');
  });
});
