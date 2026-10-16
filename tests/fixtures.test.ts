import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards against committing real user data: fixtures must be anonymized
// (see "Fixtures" in docs/platforms-claude.md).
const ROOT = join(import.meta.dirname, 'fixtures');

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

const files = listFiles(ROOT);
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const FAKE_UUID = /^00000000-0000-4000-8000-[0-9a-f]{12}$/;
/** Gemini conversation, response and candidate ids; fake ones start with zeros. */
const GEMINI_ID = /\b(?:c|r|rc)_[0-9a-f]{16}\b/g;

describe('fixtures', () => {
  it('exist', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.filter((f) => f.endsWith('.json')))('%s is valid JSON', (file) => {
    expect(() => JSON.parse(readFileSync(file, 'utf8')) as unknown).not.toThrow();
  });

  it.each(files)('%s contains only example.com email addresses', (file) => {
    const emails = readFileSync(file, 'utf8').match(EMAIL) ?? [];
    expect(emails.filter((e) => !e.endsWith('@example.com'))).toEqual([]);
  });

  it.each(files)('%s contains only fake UUIDs', (file) => {
    const uuids = readFileSync(file, 'utf8').match(UUID) ?? [];
    expect(uuids.filter((u) => !FAKE_UUID.test(u))).toEqual([]);
  });

  it.each(files)('%s contains only fake Gemini ids', (file) => {
    const ids = readFileSync(file, 'utf8').match(GEMINI_ID) ?? [];
    expect(ids.filter((id) => !/_0{8}/.test(id))).toEqual([]);
  });
});
