import { afterEach, describe, expect, it, vi } from 'vitest';
import { setBadge } from '../../src/background/badge';

function stubAction() {
  const calls: [string, unknown][] = [];
  const record = (name: string) => (details: unknown) => {
    calls.push([name, details]);
    return Promise.resolve();
  };
  vi.stubGlobal('chrome', {
    action: {
      setBadgeText: record('text'),
      setBadgeBackgroundColor: record('background'),
      setBadgeTextColor: record('textColor'),
    },
  });
  return calls;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('setBadge', () => {
  it('shows warnings in yellow with a dark mark, then clears it', async () => {
    vi.useFakeTimers();
    const calls = stubAction();
    await setBadge('partial', { clearAfterMs: 8000 });
    expect(calls).toEqual([
      ['background', { color: '#ffb000' }],
      ['textColor', { color: '#14161f' }],
      ['text', { text: '!' }],
    ]);
    await vi.advanceTimersByTimeAsync(8000);
    expect(calls.at(-1)).toEqual(['text', { text: '' }]);
  });

  it('marks one tab, and keeps "working" until the result', async () => {
    vi.useFakeTimers();
    const calls = stubAction();
    await setBadge('working', { tabId: 7, clearAfterMs: 5000 });
    await vi.advanceTimersByTimeAsync(10000);
    expect(calls.at(-1)).toEqual(['text', { tabId: 7, text: '…' }]);
    expect(calls).toContainEqual(['textColor', { tabId: 7, color: '#ffffff' }]);
  });
});
