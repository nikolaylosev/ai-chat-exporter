import { describe, expect, it } from 'vitest';
import {
  ChatNotFoundError,
  PlatformBusyError,
  PlatformFormatError,
} from '../../src/adapters/errors';
import { toCodedError } from '../../src/content/common';
import { HttpError } from '../../src/util/http';

describe('toCodedError', () => {
  it.each([
    [new HttpError(401, 'u'), 'not-signed-in'],
    [new HttpError(429, 'u'), 'rate-limited'],
    [new HttpError(404, 'u'), 'chat-not-found'],
    [new ChatNotFoundError('gemini.google.com', 'abc'), 'chat-not-found'],
    [new PlatformBusyError('gemini.google.com', 'x'), 'platform-busy'],
    [new PlatformFormatError('claude.ai', 'field', 'x'), 'format-changed'],
  ])('%s → %s', (error, code) => {
    expect((toCodedError(error) as { code?: string }).code).toBe(code);
  });

  it('leaves other errors as they are', () => {
    const error = new Error('odd');
    expect(toCodedError(error)).toBe(error);
  });
});
