// Ranked horizontal bars in one hue: the parts of a whole, largest first. Every row
// prints its name, amount and share, so the list itself is the table view.
import { el } from './dom.js';

const SHOWN = 8;

function share(amount, total) {
  if (total <= 0 || amount <= 0) return '';
  const percent = (amount * 100) / total;
  return percent < 1 ? '<1%' : `${Math.round(percent)}%`;
}

function barRow(item, max, total) {
  const width = max > 0 && item.amount > 0 ? Math.max(1, (item.amount * 100) / max) : 0;
  const percent = share(item.amount, total);
  const content = [
    el('span', { class: 'bar-top' },
      el('span', { class: 'bar-label' }, item.label),
      el('span', { class: `bar-amount${item.amount < 0 ? ' owed' : ''}` }, item.display)),
    el('span', { class: 'bar-mid' },
      el('span', { class: 'bar-track' }, el('span', { class: 'bar-fill', style: `width: ${width}%` })),
      el('span', { class: 'bar-share' }, percent)),
    item.sub && el('span', { class: 'bar-sub' }, item.sub),
  ];
  const label = `${item.label}: ${item.display}${percent ? `, ${percent}` : ''}`;
  if (item.href) {
    return el('li', {}, el('a', { class: 'bar-row', href: item.href, 'aria-label': label, 'data-bar': item.label }, content));
  }
  if (item.children?.length) {
    const details = el('ul', { class: 'rows bar-children', hidden: true }, item.children);
    const button = el('button', {
      class: 'bar-row', type: 'button', 'aria-label': label, 'aria-expanded': 'false', 'data-bar': item.label,
      onClick: () => {
        details.hidden = !details.hidden;
        button.setAttribute('aria-expanded', String(!details.hidden));
      },
    }, content);
    return el('li', {}, button, details);
  }
  return el('li', { class: 'bar-row', 'aria-label': label, 'data-bar': item.label }, content);
}

// tone: 'money' | 'owe' | 'owed' picks the single hue of the chart.
export function barList(items, { tone = 'money', total = null } = {}) {
  const whole = total ?? items.reduce((sum, item) => sum + Math.max(item.amount, 0), 0);
  const max = Math.max(0, ...items.map((item) => item.amount));
  const list = el('ul', { class: `rows bars bars-${tone}` }, items.slice(0, SHOWN).map((item) => barRow(item, max, whole)));
  if (items.length > SHOWN) {
    const more = el('li', {}, el('button', {
      class: 'row row-button bar-more',
      type: 'button',
      onClick: () => more.replaceWith(...items.slice(SHOWN).map((item) => barRow(item, max, whole))),
    }, `Показать все (${items.length})`));
    list.append(more);
  }
  return list;
}
