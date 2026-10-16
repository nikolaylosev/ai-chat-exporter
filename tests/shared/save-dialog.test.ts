import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSaveDialogSeen, setSaveDialogSeen } from '../../src/shared/save-dialog';

describe('save dialog flag', () => {
  let store: Record<string, unknown>;

  beforeEach(() => {
    store = {};
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: (key: string) => Promise.resolve(key in store ? { [key]: store[key] } : {}),
          set: (items: Record<string, unknown>) =>
            Promise.resolve(void Object.assign(store, items)),
          remove: (key: string) => Promise.resolve(void delete store[key]),
        },
      },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('is not set by default', async () => {
    expect(await isSaveDialogSeen()).toBe(false);
  });

  it('is remembered and then cleared', async () => {
    await setSaveDialogSeen(true);
    expect(await isSaveDialogSeen()).toBe(true);
    await setSaveDialogSeen(false);
    expect(await isSaveDialogSeen()).toBe(false);
    expect(store).toEqual({});
  });

  it('ignores a stored value of the wrong type', async () => {
    store.saveDialogSeen = 'yes';
    expect(await isSaveDialogSeen()).toBe(false);
  });
});
