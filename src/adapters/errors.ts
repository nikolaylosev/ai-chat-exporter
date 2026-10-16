import type { z } from 'zod';

/** A platform response did not have the expected shape; `path` names the field. */
export class PlatformFormatError extends Error {
  constructor(
    readonly platform: string,
    readonly path: string,
    detail: string,
  ) {
    super(`${platform} response format changed at "${path}": ${detail}`);
    this.name = 'PlatformFormatError';
  }
}

/** The service kept answering with a server error; trying later may work. */
export class PlatformBusyError extends Error {
  constructor(
    readonly platform: string,
    detail: string,
  ) {
    super(`${platform} is not answering: ${detail}`);
    this.name = 'PlatformBusyError';
  }
}

/** The conversation is not on the platform (any more): deleted, or never there. */
export class ChatNotFoundError extends Error {
  constructor(
    readonly platform: string,
    readonly id: string,
  ) {
    super(`${platform} has no conversation ${id}`);
    this.name = 'ChatNotFoundError';
  }
}

/** Parses `value`, or throws a PlatformFormatError naming the first wrong field. */
export function parseOrThrowFor<T>(
  platform: string,
  schema: z.ZodType<T>,
  value: unknown,
  where: string,
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = [where, ...(issue?.path ?? []).map(String)].join('.');
  throw new PlatformFormatError(platform, path, issue?.message ?? 'invalid value');
}
