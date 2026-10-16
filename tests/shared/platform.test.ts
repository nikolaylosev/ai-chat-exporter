import { describe, expect, it } from 'vitest';
import { detectPlatform } from '../../src/shared/platform';

describe('detectPlatform', () => {
  it.each([
    ['https://claude.ai/chat/3f2a', 'claude'],
    ['https://claude.ai/project/9c1e', 'claude'],
    ['https://gemini.google.com/app/abc', 'gemini'],
    ['https://gemini.google.com/gem/xyz', 'gemini'],
    ['http://claude.ai/chat/1', null],
    ['https://evilclaude.ai/chat/1', null],
    ['https://claude.ai.example.com/', null],
    ['https://google.com/', null],
    ['chrome://extensions', null],
    ['not a url', null],
    [undefined, null],
  ])('%j → %j', (url, expected) => {
    expect(detectPlatform(url)).toBe(expected);
  });
});
