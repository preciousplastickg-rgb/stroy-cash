import { matchItems } from './combo.js';
import { el } from './dom.js';
import { openSheet } from './sheet.js';

// Picker with search; recently used rows go first. items: { id, label, sub?, group? }.
// Resolves to an id, to { create: name } for a new record, or to undefined.
// autofocus opens the keyboard at once: for pickers that are mostly typed into.
export function openPicker({
  title, items, recentIds = [], selectedId = null, searchPlaceholder = 'Поиск', canCreate = false, createLabel = 'Создать', autofocus = false,
}) {
  return new Promise((resolve) => {
    const list = el('div', { class: 'picker-list' });
    const search = el('input', {
      class: 'input',
      type: 'search',
      placeholder: searchPlaceholder,
      autocomplete: 'off',
      enterKeyHint: 'done',
      'aria-label': searchPlaceholder,
      onInput: () => fill(),
      onKeydown: (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        list.querySelector('.picker-row')?.click();
      },
    });
    const sheet = openSheet({
      title,
      onClose: resolve,
      tall: autofocus,
      body: el('div', { class: 'picker' }, el('div', { class: 'picker-search' }, search), list),
    });

    function row(item) {
      return el('button', {
        class: `picker-row${item.id === selectedId ? ' selected' : ''}`, type: 'button', onClick: () => sheet.close(item.id),
      }, el('span', { class: 'picker-label' }, item.label), item.sub && el('span', { class: 'picker-sub' }, item.sub));
    }

    function section(heading, rows) {
      if (rows.length === 0) return [];
      return [heading && el('h3', { class: 'picker-group' }, heading), ...rows.map(row)];
    }

    function typedRows(query) {
      const found = matchItems(items, query);
      const name = query.trim();
      const known = items.some((item) => item.label.toLowerCase() === name.toLowerCase());
      const create = canCreate && !known && el('button', {
        class: 'picker-row picker-create', type: 'button', onClick: () => sheet.close({ create: name }),
      }, el('span', { class: 'picker-label' }, `${createLabel} «${name}»`));
      // An exact-looking match goes first, so Enter takes it instead of creating a twin.
      return found.length > 0 ? [...section(null, found), create] : [create];
    }

    function allRows() {
      const recent = recentIds.map((id) => items.find((item) => item.id === id)).filter(Boolean);
      const others = items.filter((item) => !recent.includes(item));
      const nodes = section('Недавние', recent);
      for (const group of new Set(others.map((item) => item.group ?? ''))) {
        const heading = group || (recent.length > 0 ? 'Остальные' : null);
        nodes.push(...section(heading, others.filter((item) => (item.group ?? '') === group)));
      }
      return nodes;
    }

    function fill() {
      const nodes = (search.value.trim() ? typedRows(search.value) : allRows()).filter(Boolean);
      if (nodes.length === 0) nodes.push(el('p', { class: 'picker-empty' }, 'Ничего не найдено'));
      list.replaceChildren(...nodes);
    }

    fill();
    if (autofocus) search.focus();
    else sheet.node.querySelector('.icon-button').focus();
  });
}
