import { normalizeName } from '../ledger.js';

// Suggestions for a typed text: start of the name first, then the start of any
// word. From three letters on, a match inside a word counts too.
export function matchItems(items, query) {
  const needle = normalizeName(query);
  if (!needle) return [];
  const score = (item) => {
    const text = normalizeName(`${item.label} ${item.sub ?? ''}`);
    if (text.startsWith(needle)) return 0;
    if (text.split(/[^a-zа-я0-9]+/).some((word) => word.startsWith(needle))) return 1;
    return needle.length >= 3 && text.includes(needle) ? 2 : null;
  };
  return items
    .map((item) => ({ item, rank: score(item) }))
    .filter(({ rank }) => rank !== null)
    .sort((a, b) => a.rank - b.rank)
    .map(({ item }) => item);
}
