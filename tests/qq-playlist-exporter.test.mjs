import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const python = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'].find(existsSync);

test('QQ playlist exporter preserves cache privacy and explicit selections', { skip: !python }, async () => {
  const file = fileURLToPath(new URL('./qq-playlist-exporter.test.py', import.meta.url));
  const result = await run(python, ['-I', file], { timeout: 20000, maxBuffer: 1024 * 1024 });
  assert.match(result.stderr, /Ran 10 tests/);
  assert.match(result.stderr, /\bOK\b/);
});
