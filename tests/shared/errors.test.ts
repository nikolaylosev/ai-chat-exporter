import { describe, expect, it } from 'vitest';
import { isUserOutcome } from '../../src/shared/errors';

describe('isUserOutcome', () => {
  it('is true for what the user did, false for failures', () => {
    expect(isUserOutcome('save-cancelled')).toBe(true);
    expect(isUserOutcome('not-a-chat')).toBe(true);
    expect(isUserOutcome('failed')).toBe(false);
    expect(isUserOutcome('save-dialog')).toBe(true);
    expect(isUserOutcome('download-cancelled')).toBe(true);
    expect(isUserOutcome('rate-limited')).toBe(false);
  });

  it('is true for access the user is asked for', () => {
    expect(isUserOutcome('folder-permission')).toBe(true);
    expect(isUserOutcome('folder-not-chosen')).toBe(true);
    expect(isUserOutcome('platform-access')).toBe(true);
    expect(isUserOutcome('folder-missing')).toBe(false);
  });
});
