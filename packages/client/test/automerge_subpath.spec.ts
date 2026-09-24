import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as automerge from '../src/automerge.js';
import * as root from '../src/index.js';

describe('Automerge entry point', () => {
  it('keeps useAutomergeDoc off the root barrel, so Yjs apps never load its WASM', () => {
    expect('useAutomergeDoc' in root).toBe(false);
    expect(typeof automerge.useAutomergeDoc).toBe('function');
  });

  it('publishes the subpath', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    expect(pkg.exports['./automerge'].import).toBe('./dist/src/automerge.js');
  });
});
