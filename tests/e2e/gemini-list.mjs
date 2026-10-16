// A synthetic Gemini account for the export page: 60 chats (copies of the basic
// fixture) and a Gem chat over three list pages, plus 40 older chats only the
// search finds, each title leading to the next.
import { fixture } from './fakes.mjs';

export function geminiAccount() {
  const chats = {};
  const entries = [];
  const basic = JSON.stringify(fixture('gemini', 'conversation-basic.json'));
  for (let i = 1; i <= 60; i++) {
    const id = 'a' + String(i).padStart(15, '0');
    const chat = JSON.parse(
      basic
        .replaceAll('c_0000000000000001', `c_${id}`)
        .replaceAll('Fruit List and Python Code', `Stand chat ${i}`),
    );
    chat.meta[2][0][5] = [1791923915 - i * 3600, 0];
    chats[id] = chat;
    entries.push(chat.meta[2][0]);
  }
  const gem = fixture('gemini', 'conversation-gem.json');
  chats[gem.meta[2][0][0].slice(2)] = gem;
  entries.splice(5, 0, gem.meta[2][0]);
  const searchable = Array.from({ length: 40 }, (_, i) => ({
    id: 'b' + String(i + 1).padStart(15, '0'),
    title: `Old test chat ${i + 1} word${i + 1}x word${i + 2}x`,
  }));
  return {
    chats,
    pages: [entries.slice(0, 27), entries.slice(27, 47), entries.slice(47)],
    searchable,
  };
}
