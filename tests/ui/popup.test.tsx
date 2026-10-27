// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
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

describe('popup: files and the clipboard', () => {
  const chat = 'https://claude.ai/chat/00000000-0000-4000-8000-000000000001';

  it('has "Save with files", no .zip choice, and a Copy button next to Save', async () => {
    stubChrome({ activeTab: { id: 3, url: chat } });
    render(<Popup />);
    const files = await screen.findByRole<HTMLInputElement>('checkbox', { name: 'saveWithFiles' });
    expect(files.checked).toBe(true);
    fireEvent.click(files);
    // With files into Downloads a chat is always one .zip: nothing to choose.
    expect(screen.queryByText('saveAsZip')).toBeNull();
    const copy = screen.getByRole<HTMLButtonElement>('button', { name: 'popupCopyChat' });
    expect(copy.title).toBe('popupCopyHint');
    expect(screen.getByRole('button', { name: 'popupSaveChat' })).toBeTruthy();
  });

  it('copies the chat as Markdown, saving nothing', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const asked: string[] = [];
    stubChrome({
      activeTab: { id: 3, url: chat },
      background: (type) => {
        asked.push(type);
        return type === 'export:copy'
          ? { ok: true, title: 'Chat', messageCount: 4, markdown: '# Chat\n' }
          : null;
      },
    });
    render(<Popup />);
    const copy = await screen.findByRole<HTMLButtonElement>('button', { name: 'popupCopyChat' });
    await vi.waitFor(() => expect(copy.disabled).toBe(false));
    fireEvent.click(copy);
    await screen.findByText('popupCopied(4)');
    expect(writeText).toHaveBeenCalledWith('# Chat\n');
    expect(asked).not.toContain('export:current');
  });
});

describe('popup: a cancelled save', () => {
  it('says so quietly, not as an error', async () => {
    stubChrome({
      activeTab: { id: 3, url: 'https://claude.ai/chat/00000000-0000-4000-8000-000000000001' },
      background: (type) =>
        type === 'export:current'
          ? { ok: false, code: 'save-cancelled', message: 'error_save_cancelled' }
          : null,
    });
    render(<Popup />);
    const save = await screen.findByRole<HTMLButtonElement>('button', { name: 'popupSaveChat' });
    await vi.waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    const message = await screen.findByText('error_save_cancelled');
    expect(message.className).toContain('muted');
    expect(message.className).not.toContain('error');
  });
});

describe('popup: note format', () => {
  it('chooses the note format above the settings link', async () => {
    const { local } = stubChrome({
      activeTab: { id: 3, url: 'https://claude.ai/chat/00000000-0000-4000-8000-000000000001' },
    });
    render(<Popup />);
    const select = await screen.findByRole<HTMLSelectElement>('combobox', { name: 'noteFormat' });
    expect(select.value).toBe('markdown');
    fireEvent.change(select, { target: { value: 'html' } });
    await vi.waitFor(() =>
      expect((local.settings as { noteFormat?: string } | undefined)?.noteFormat).toBe('html'),
    );
  });
});

describe('popup: a browser that cannot write into a folder', () => {
  it('says why instead of asking for access (Brave without its flag)', async () => {
    const asked: string[] = [];
    const { local } = stubChrome({
      activeTab: { id: 3, url: 'https://claude.ai/chat/00000000-0000-4000-8000-000000000001' },
      background: (type) => {
        asked.push(type);
        return null;
      },
    });
    local.settings = { destination: 'folder' };
    expect('showDirectoryPicker' in globalThis).toBe(false);
    render(<Popup />);
    const save = await screen.findByRole<HTMLButtonElement>('button', { name: 'popupSaveChat' });
    await vi.waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await screen.findByText('error_folder_unsupported');
    expect(asked).not.toContain('export:current');
  });
});
