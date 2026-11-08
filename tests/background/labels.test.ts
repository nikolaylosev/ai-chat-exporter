import { afterEach, describe, expect, it, vi } from 'vitest';
import { duration } from '../../src/background/labels';

afterEach(() => vi.unstubAllGlobals());

describe('duration', () => {
  it.each([
    [0.3, 'mdSeconds(1)'],
    [42, 'mdSeconds(42)'],
    [59.6, 'mdMinutesSeconds(1,0)'],
    [162, 'mdMinutesSeconds(2,42)'],
  ])('%s s', (seconds, expected) => {
    vi.stubGlobal('chrome', {
      i18n: {
        getMessage: (key: string, subs?: string | string[]) =>
          `${key}(${[subs ?? []].flat().join(',')})`,
      },
    });
    expect(duration(seconds)).toBe(expected);
  });
});
