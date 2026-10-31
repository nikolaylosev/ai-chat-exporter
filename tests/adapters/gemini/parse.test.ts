import { describe, expect, it } from 'vitest';
import { readHistoryPage, readTurn } from '../../../src/adapters/gemini/parse';
import { toConversation } from '../../../src/adapters/gemini/normalize';
import { fixture } from './server';

/** The first turn of the basic chat, as Gemini sent it. */
const turn = () =>
  structuredClone(
    (fixture('conversation-basic.json') as { history: unknown[][][] }).history[0]![0]![0],
  ) as unknown[];

describe('Gemini history turns', () => {
  it('reads the answer shown, or else the first answer with text', () => {
    const shown = readTurn(turn(), 't');
    const other = turn();
    const answers = other[3] as unknown[];
    const candidates = answers[0] as unknown[][];
    // The chosen id names no answer, and an empty one comes first.
    answers[3] = 'rc_gone';
    candidates.unshift(['rc_empty', [''], ...candidates[0]!.slice(2)]);
    expect(readTurn(other, 't').answer).toBe(shown.answer);
  });

  it('keeps a turn in a shape not known as a mark, and the chat goes on', () => {
    const broken = turn();
    broken[3] = null;
    const { turns } = readHistoryPage([[turn(), broken], null], 'h');
    expect(turns.map((t) => Boolean(t.unreadable))).toEqual([false, true]);
    const c = toConversation(turns, {
      id: 'x',
      title: 'X',
      updatedAt: null,
      url: 'https://gemini.google.com/app/x',
    });
    expect(c.messages.at(-1)).toMatchObject({
      role: 'assistant',
      blocks: [{ type: 'unreadable', kind: 'a turn in a format not known yet' }],
    });
    expect(c.messages).toHaveLength(3);
  });

  it('still fails on a page that is not a list of turns', () => {
    expect(() => readHistoryPage([null, null], 'h')).toThrow(/a list of turns/);
  });
});
