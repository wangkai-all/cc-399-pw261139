import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labtest-'));
  return { dir, file: path.join(dir, 'test.sqlite') };
}

export function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
