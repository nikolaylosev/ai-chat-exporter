import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { conversationSchema, type RawConversation } from '../../../src/adapters/claude/schema';

export const ORG = '00000000-0000-4000-8000-0000000000a1';
export const ORIGIN = 'https://claude.ai';

const DIR = join(import.meta.dirname, '../../fixtures/claude');

export function fixtureJson(name: string): unknown {
  return JSON.parse(readFileSync(join(DIR, name), 'utf8')) as unknown;
}

export function rawConversation(name: string): RawConversation {
  return conversationSchema.parse(fixtureJson(name));
}
