import { describe, expect, it } from 'vitest';
import { Pacer } from '../../../src/adapters/chatgpt/pacer';

function clock() {
  let now = 0;
  const waits: number[] = [];
  const sleep = (ms: number) => {
    waits.push(ms);
    now += ms;
    return Promise.resolve();
  };
  return { now: () => now, advance: (ms: number) => (now += ms), sleep, waits };
}

describe('Pacer', () => {
  it('keeps the gap between requests', async () => {
    const c = clock();
    const pacer = new Pacer(500, c.sleep, c.now);
    await pacer.turn();
    await pacer.turn();
    c.advance(200);
    await pacer.turn();
    c.advance(900);
    await pacer.turn();
    expect(c.waits).toEqual([500, 300]);
  });

  it('widens the gap after a 429 and narrows it after a calm stretch', () => {
    const c = clock();
    const pacer = new Pacer(500, c.sleep, c.now, 16_000, 3);
    pacer.observe(429);
    expect(pacer.gapMs).toBe(1000);
    for (let i = 0; i < 6; i++) pacer.observe(429);
    expect(pacer.gapMs).toBe(16_000);
    for (let i = 0; i < 3; i++) pacer.observe(200);
    expect(pacer.gapMs).toBe(8000);
    for (let i = 0; i < 30; i++) pacer.observe(200);
    expect(pacer.gapMs).toBe(500);
  });

  it('does without a gap when the base is 0, until a 429', async () => {
    const c = clock();
    const pacer = new Pacer(0, c.sleep, c.now);
    await pacer.turn();
    await pacer.turn();
    expect(c.waits).toEqual([]);
    pacer.observe(429);
    await pacer.turn();
    expect(c.waits).toEqual([1000]);
  });
});
