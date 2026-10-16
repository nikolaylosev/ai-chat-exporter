// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Popup } from '../../src/ui/popup/popup';
import { stubChrome } from './fake-chrome';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('popup', () => {
  it.each([
    ['https://chatgpt.com/c/00000000-0000-4000-8000-000000000001', 'popupDetected(ChatGPT)', true],
    ['https://gemini.google.com/app/0123456789abcdef', 'popupDetected(Gemini)', true],
    ['https://chatgpt.com/', 'popupNotAChat', false],
    ['https://example.com/', 'popupUnsupported', false],
  ])('on %s says %s', async (url, text, canSave) => {
    stubChrome({ activeTab: { id: 3, url } });
    render(<Popup />);
    await screen.findByText(text);
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'popupSaveChat' });
    // Enabled once the settings are read, for a chat page only.
    await vi.waitFor(() => expect(save.disabled).toBe(!canSave));
  });
});

describe('popup on a Gemini notebook', () => {
  it('offers to save the notebook with its chats', async () => {
    stubChrome({
      activeTab: {
        id: 4,
        url: 'https://gemini.google.com/notebook/00000000-0000-4000-8000-0000000000b0',
      },
      background: (type) =>
        type === 'project:of-tab'
          ? { id: '00000000-0000-4000-8000-0000000000b0', name: 'Fruit' }
          : null,
    });
    render(<Popup />);
    await screen.findByText('popupNotebookPage');
    await screen.findByText('popupNotebook(Fruit)');
    expect(screen.getByRole('button', { name: 'popupSaveNotebook' })).toBeTruthy();
    expect(screen.queryByText('withChats')).toBeNull();
    expect(screen.getByRole('button', { name: 'popupChooseNotebooks' })).toBeTruthy();
  });
});

describe('popup on a Grok project', () => {
  it('offers to save the project with its chats', async () => {
    const project = '00000000-0000-4000-8000-0000000000c0';
    stubChrome({
      activeTab: { id: 5, url: `https://grok.com/project/${project}` },
      background: (type) =>
        type === 'project:of-tab' ? { id: project, name: 'Photo book' } : null,
    });
    render(<Popup />);
    await screen.findByText('popupProjectPage');
    await screen.findByText('popupProject(Photo book)');
    expect(screen.getByRole('button', { name: 'popupSaveProject' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'popupChooseProjects' })).toBeTruthy();
  });

  it('treats a chat open in the project as a chat', async () => {
    const project = '00000000-0000-4000-8000-0000000000c0';
    const chat = '00000000-0000-4000-8000-000000000006';
    stubChrome({
      activeTab: { id: 5, url: `https://grok.com/project/${project}?chat=${chat}` },
      background: (type) =>
        type === 'project:of-tab' ? { id: project, name: 'Photo book' } : null,
    });
    render(<Popup />);
    await screen.findByText('popupDetected(Grok)');
    await screen.findByText('popupProject(Photo book)');
  });
});
