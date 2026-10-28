import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { readTakeout, takeoutChatIds } from '../../src/ui/export-page/takeout';

/** Activity records as Takeout writes them (made up). */
const prompt = (id: string, time: string, account = '') => ({
  header: 'Gemini Apps',
  title: 'Prompted something',
  time,
  products: ['Gemini Apps'],
  details: [
    {
      name: `https://gemini.google.com${account}/app/${id}`,
      url: `https://gemini.google.com${account}/app/${id}`,
    },
  ],
  activityControls: ['Gemini Apps Activity'],
});
const activity = [
  prompt('00000000000000a1', '2026-10-01T10:00:00.000Z'),
  prompt('00000000000000a2', '2026-10-03T10:00:00.000Z', '/u/1'),
  prompt('00000000000000a1', '2026-10-05T10:00:00.000Z'),
  { header: 'Gemini Apps', title: 'Cleared something', time: '2026-10-06T10:00:00.000Z' },
  {
    header: 'Gemini Apps',
    title: 'Used something',
    time: '2026-10-07T10:00:00.000Z',
    details: [{ url: 'https://example.com/app/00000000000000ff' }],
  },
];

describe('takeoutChatIds', () => {
  it('gives each linked chat once, the most recently used first', () => {
    expect(takeoutChatIds(activity)).toEqual(['00000000000000a1', '00000000000000a2']);
  });

  it('gives none for anything else', () => {
    expect(takeoutChatIds({ records: activity })).toEqual([]);
    expect(takeoutChatIds([null, 1, 'x', { details: 'x' }])).toEqual([]);
  });
});

describe('readTakeout', () => {
  const json = JSON.stringify(activity);

  it('reads the activity file itself', async () => {
    const file = new File([json], 'MyActivity.json');
    expect(await readTakeout(file)).toEqual(['00000000000000a1', '00000000000000a2']);
  });

  it('reads the Gemini activity out of a Takeout archive, leaving the rest', async () => {
    const zip = zipSync({
      'Takeout/My Activity/Gemini Apps/MyActivity.json': strToU8(json),
      'Takeout/My Activity/Search/MyActivity.json': strToU8(
        JSON.stringify([prompt('00000000000000b1', '2026-10-09T10:00:00.000Z')]),
      ),
      'Takeout/My Activity/Gemini Apps/photo.jpg': new Uint8Array([1, 2, 3]),
    });
    const file = new File([zip], 'takeout-20261028.zip');
    expect(await readTakeout(file)).toEqual(['00000000000000a1', '00000000000000a2']);
  });

  it('gives none for a file that is not an activity file', async () => {
    expect(await readTakeout(new File(['<html></html>'], 'MyActivity.html'))).toEqual([]);
  });
});
