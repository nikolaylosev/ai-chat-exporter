// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSummary } from '../../src/model/conversation';
import { ExportPage } from '../../src/ui/export-page/page';
import { stubChrome } from './fake-chrome';

const chat = (id: string, platform: 'claude' | 'gemini' = 'claude'): ConversationSummary => ({
  id,
  platform,
  title: `Chat ${id}`,
  createdAt: '2026-10-01T10:00:00Z',
  updatedAt: '2026-10-02T10:00:00Z',
  url: `https://example.test/${id}`,
});
const rows = () => document.querySelectorAll('tbody tr').length;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('export page: the chat list', () => {
  it('can be stopped while it loads, and then lists the chats read so far', async () => {
    history.replaceState(null, '', '?');
    let finish: (list: unknown) => void = () => undefined;
    const { sentToTabs, toPages } = stubChrome({
      background: (type) => (type === 'platform:tab' ? { tabId: 7, opened: false } : null),
      tab: (type) => {
        if (type === 'conversations:list') return new Promise((resolve) => (finish = resolve));
        if (type === 'conversations:list-stop') {
          finish({
            conversations: [chat('a'), chat('b'), chat('c')],
            incomplete: { loaded: 3, stopped: true },
          });
        }
        return null;
      },
    });
    render(<ExportPage />);
    await waitFor(() => expect(sentToTabs.map((m) => m.type)).toContain('conversations:list'));
    await act(() => toPages('list:progress', { platform: 'claude', loaded: 3 }));
    await screen.findByText(/exportLoadingCount\(3\)/);

    fireEvent.click(screen.getByRole('button', { name: 'exportListStop' }));
    await screen.findByText(/exportListStopped\(3\)/);
    expect(sentToTabs.find((m) => m.type === 'conversations:list-stop')?.tabId).toBe(7);
    expect(rows()).toBe(3);
    expect(screen.getByRole('button', { name: 'exportListLoadAll' })).toBeTruthy();
  });

  it('says the platform stopped answering when the list was cut short', async () => {
    history.replaceState(null, '', '?');
    stubChrome({
      background: (type) => (type === 'platform:tab' ? { tabId: 7, opened: false } : null),
      tab: (type) =>
        type === 'conversations:list'
          ? { conversations: [chat('a')], incomplete: { loaded: 1 } }
          : null,
    });
    render(<ExportPage />);
    await screen.findByText(/exportListIncomplete\(Claude,1\)/);
    expect(screen.getByRole('button', { name: 'exportRetry' })).toBeTruthy();
  });
});

describe('export page: Gemini search', () => {
  it('shows remembered results, adds new ones as each query finds them, and remembers them', async () => {
    history.replaceState(null, '', '?platform=gemini');
    let finishSearch: (result: unknown) => void = () => undefined;
    const { local, toPages } = stubChrome({
      background: (type) => (type === 'platform:tab' ? { tabId: 9, opened: false } : null),
      tab: (type) => {
        if (type === 'conversations:list') {
          return { conversations: [chat('g1', 'gemini'), chat('g2', 'gemini')] };
        }
        if (type === 'conversations:search') {
          return new Promise((resolve) => (finishSearch = resolve));
        }
        return null;
      },
    });
    local['searchFound:gemini'] = [{ ...chat('old', 'gemini'), foundBySearch: true }];
    render(<ExportPage />);
    await screen.findByText(/exportSources\(2,1,0,0\)/);
    expect(rows()).toBe(3);

    fireEvent.click(screen.getByRole('button', { name: 'exportSearchMore' }));
    const found = { ...chat('new', 'gemini'), foundBySearch: true };
    await waitFor(() => screen.getByText(/exportSearchRunning/));
    await act(() =>
      toPages('search:progress', {
        platform: 'gemini',
        found: 1,
        queries: 1,
        conversations: [found],
      }),
    );
    await waitFor(() => expect(rows()).toBe(4));
    await waitFor(() =>
      expect((local['searchFound:gemini'] as ConversationSummary[]).map((c) => c.id)).toEqual([
        'old',
        'new',
      ]),
    );
    const state = { asked: ['и'], words: [['word', 1]], seen: ['g1', 'new'] };
    finishSearch({ conversations: [found], queries: 1, end: 'exhausted', state });
    await screen.findByText(/exportSearchDone\(1,1\)/);
    expect(rows()).toBe(4);
    // Where it stopped is kept for the next search.
    await waitFor(() => expect(local['searchState:gemini']).toEqual(state));
    expect(screen.getByRole('button', { name: 'exportSearchAgain' })).toBeTruthy();

    // The bulk export found 'old' gone from Gemini and forgot it: the table follows.
    await act(() =>
      chrome.storage.local.set({
        'searchFound:gemini': [found],
      }),
    );
    await waitFor(() => expect(rows()).toBe(3));
    expect(screen.queryByText('Chat old')).toBeNull();
  });
});

describe('export page: Gemini chats from Takeout', () => {
  it('asks the Gemini tab for the chats the file links to that the table does not have', async () => {
    history.replaceState(null, '', '?platform=gemini');
    const listed = chat('00000000000000c1', 'gemini');
    const old = { ...chat('00000000000000c2', 'gemini'), fromTakeout: true };
    const { local, sentToTabs } = stubChrome({
      background: (type) => (type === 'platform:tab' ? { tabId: 9, opened: false } : null),
      tab: (type) => {
        if (type === 'conversations:list') return { conversations: [listed] };
        if (type === 'conversations:lookup') {
          return { conversations: [old], missing: ['00000000000000c3'], failed: [] };
        }
        return null;
      },
    });
    render(<ExportPage />);
    await screen.findByRole('button', { name: 'exportTakeoutAdd' });
    const link = (id: string) => ({
      time: '2026-10-01T10:00:00.000Z',
      details: [{ url: `https://gemini.google.com/app/${id}` }],
    });
    const file = new File(
      [JSON.stringify(['c1', 'c2', 'c3'].map((n) => link(`00000000000000${n}`)))],
      'MyActivity.json',
    );
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    fireEvent.change(input);

    await screen.findByText(/exportTakeoutDone\(1,1,1\)/);
    expect(sentToTabs.find((m) => m.type === 'conversations:lookup')?.payload).toEqual({
      ids: ['00000000000000c2', '00000000000000c3'],
      atOnce: 4,
    });
    expect(rows()).toBe(2);
    screen.getByText(/exportSources\(1,0,1,0\)/);
    screen.getByText('exportFromTakeout');
    await waitFor(() =>
      expect((local['searchFound:gemini'] as ConversationSummary[]).map((c) => c.id)).toEqual([
        '00000000000000c2',
      ]),
    );
  });
});

describe('export page: Gemini notebooks', () => {
  it('lists notebooks on their own tab and exports the chosen one with its chats', async () => {
    history.replaceState(null, '', '?platform=gemini&tab=projects');
    const started: unknown[] = [];
    stubChrome({
      background: (type, payload) => {
        if (type === 'projects:list') {
          return [
            {
              id: 'nb1',
              platform: 'gemini',
              name: 'Fruit',
              description: '',
              createdAt: null,
              updatedAt: '2026-10-02T10:00:00Z',
              url: 'https://gemini.google.com/notebook/nb1',
              knowledgeCount: 1,
            },
          ];
        }
        if (type === 'job:start') started.push(payload);
        return null;
      },
    });
    render(<ExportPage />);
    expect(screen.getByRole('tab', { name: 'exportTabNotebooks' })).toBeTruthy();
    await screen.findByText('Fruit');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Fruit' }));
    // No "with its chats" box: a notebook always goes with its chats.
    expect(screen.queryByText('withChats')).toBeNull();
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'exportStartNotebooks(1)' });
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toMatchObject({
      platform: 'gemini',
      items: [{ kind: 'project', id: 'nb1', title: 'Fruit', withChats: true }],
    });
  });
});

describe('export page: ChatGPT projects', () => {
  it('has a Projects tab', async () => {
    history.replaceState(null, '', '?platform=chatgpt&tab=projects');
    stubChrome({
      background: (type) =>
        type === 'projects:list'
          ? [
              {
                id: 'g-p-1',
                platform: 'chatgpt',
                name: 'Airlines',
                description: '',
                createdAt: null,
                updatedAt: '2026-10-16T07:40:00Z',
                url: 'https://chatgpt.com/g/g-p-1/project',
                knowledgeCount: 0,
              },
            ]
          : null,
    });
    render(<ExportPage />);
    expect(screen.getByRole('tab', { name: 'exportTabProjects' })).toBeTruthy();
    await screen.findByText('Airlines');
    // No "with its chats" box: a project always goes with its chats.
    expect(screen.getByRole('button', { name: 'exportStartProjects(0)' })).toBeTruthy();
    // Files can be left out here too, next to .zip.
    expect(screen.getByRole('checkbox', { name: 'saveWithFiles' })).toBeTruthy();
  });
});
