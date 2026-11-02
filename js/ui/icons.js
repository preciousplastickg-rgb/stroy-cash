// Line icons drawn on a 24 px grid. Kept as paths so the app stays offline and tiny.
const PATHS = {
  cash: 'M3 7h18v10H3z M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5 M6.5 10v4 M17.5 10v4',
  usd: 'M12 3v18 M16.5 7.5C16 6 14.3 5 12 5c-2.5 0-4.5 1.3-4.5 3.3 0 4.4 9 2.6 9 7.2 0 2-2 3.5-4.5 3.5-2.4 0-4.2-1.1-4.7-2.8',
  bank: 'M3 10l9-6 9 6 M5.5 10v8 M9.8 10v8 M14.2 10v8 M18.5 10v8 M3 20h18',
  card: 'M3 6h18v12H3z M3 10h18 M7 15h4',
  wallet: 'M4 7h15a1 1 0 0 1 1 1v11H4z M4 7l11-3v3 M15.5 13h2',
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M4.5 20c1.4-3.3 4.2-5 7.5-5s6.1 1.7 7.5 5',
  people: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7 M2.5 19.5c1.2-3 3.6-4.5 6.5-4.5s5.3 1.5 6.5 4.5 M16 4.3a3.5 3.5 0 0 1 0 6.4 M18 15.2c1.6.6 2.8 2 3.5 4.3',
  expense: 'M7 17L17 7 M9 7h8v8',
  income: 'M17 7L7 17 M15 17H7V9',
  transfer: 'M4 9h15l-3.5-3.5 M20 15H5l3.5 3.5',
  give: 'M12 4v10 M7.5 9.5L12 14l4.5-4.5 M5 19h14',
  repeat: 'M20 9a8 8 0 0 0-14.3-2.7L4 8.5 M4 4v4.5h4.5 M4 15a8 8 0 0 0 14.3 2.7L20 15.5 M20 20v-4.5h-4.5',
  car: 'M4 16v-3.5L6.5 7h11l2.5 5.5V16z M4 12.5h16 M7.5 19.5a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6 M16.5 19.5a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6',
  calendar: 'M4 6h16v14H4z M4 10h16 M8 3v4 M16 3v4 M9 15l2 2 4-4',
  wallet2: 'M4 7h16v12H4z M16 13h2',
  building: 'M4 20V9l6-4v15 M10 20V10h10v10 M3 20h18 M14 14h2 M14 17h2',
  tag: 'M3.5 12.5l9-9h8v8l-9 9z M15.5 8.5h.01',
  list: 'M8 6h12 M8 12h12 M8 18h12 M4 6h.01 M4 12h.01 M4 18h.01',
  backup: 'M7 18a5 5 0 0 1-.6-10A6 6 0 0 1 18 9a4.5 4.5 0 0 1-1 9z M12 11v6 M9.5 13.5L12 11l2.5 2.5',
  photo: 'M4 7.5h3.5L9.5 5h5l2 2.5H20V19H4z M12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7',
  restore: 'M4 12a8 8 0 1 0 2.4-5.7L4 8.7 M4 4v4.7h4.7',
  lock: 'M6 11h12v9H6z M8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  briefcase: 'M4 8h16v11H4z M9 8V5h6v3 M4 13h16',
  rate: 'M4 17l5-5 4 4 7-8 M15 8h5v5',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  trash: 'M5 7h14 M10 4h4 M7 7l1 13h8l1-13',
  plus: 'M12 5v14 M5 12h14',
  play: 'M8 5l11 7-11 7z',
  chevron: 'M9 5l7 7-7 7',
};

export function icon(name, className = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', className);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', PATHS[name] ?? PATHS.list);
  svg.append(path);
  return svg;
}

// A coloured rounded square with a white glyph, as in iOS settings.
export function badge(name, tone) {
  const node = document.createElement('span');
  node.className = `badge tone-${tone}`;
  node.append(icon(name, 'badge-icon'));
  return node;
}

export const ACCOUNT_ICONS = { cash: 'cash', bank: 'bank', card: 'card', ewallet: 'wallet', imprest: 'person', barter: 'car' };

export function accountBadge(account) {
  if (account.currency === 'USD') return badge('usd', 'green');
  const tones = { cash: 'teal', bank: 'blue', card: 'indigo', ewallet: 'orange', imprest: 'gray', barter: 'brown' };
  return badge(ACCOUNT_ICONS[account.type] ?? 'wallet', tones[account.type] ?? 'gray');
}
