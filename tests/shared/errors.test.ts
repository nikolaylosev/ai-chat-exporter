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
});
