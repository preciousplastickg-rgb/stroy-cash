// Parts shared by the operation forms.
import { LedgerError } from '../ledger.js';
import { setLeaveGuard } from '../nav.js';
import { formatDate } from '../money.js';
import { attachAmountInput } from './amount-input.js';
import { confirmSheet } from './confirm.js';
import { el } from './dom.js';

export function formRow({ name, label, value, placeholder, note, onClick }) {
  return el('button', { class: 'form-row', type: 'button', 'data-name': name, 'data-more': name, disabled: !onClick, onClick },
    el('span', { class: 'row-label' }, label),
    el('span', { class: `row-value${value ? '' : ' empty'}` }, value || placeholder),
    note && el('span', { class: 'row-note' }, note));
}

export function dateRow({ name, label, value, max, onChange, placeholder = 'Не указано' }) {
  const input = el('input', {
    class: 'date-input', type: 'date', value: value ?? '', max: max ?? null, 'aria-label': label,
    onChange: () => onChange(input.value || null),
  });
  return el('label', { class: 'form-row date-row', 'data-name': name },
    el('span', { class: 'row-label' }, label),
    el('span', { class: `row-value${value ? '' : ' empty'}` }, value ? formatDate(value) : placeholder),
    input,
    el('span', { class: 'field-error', hidden: true }));
}

export function amountBox({ id, label = 'Сумма', currency = 'KGS', onChange }) {
  const input = el('input', {
    class: 'amount-input', id, type: 'text', inputMode: 'decimal', autocomplete: 'off', enterKeyHint: 'done', placeholder: '0', 'aria-label': label,
    onKeydown: (event) => {
      if (event.key === 'Enter') input.blur();
    },
  });
  attachAmountInput(input, onChange);
  const currencyLabel = el('span', { class: 'amount-currency' }, currency === 'USD' ? '$' : 'сом');
  return {
    input,
    box: el('div', { class: 'amount-box' }, input, currencyLabel),
    setCurrency: (value) => {
      currencyLabel.textContent = value === 'USD' ? '$' : 'сом';
    },
  };
}

const BACK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';

// The button returns to the screen that opened this one; href is where it leads
// when nothing is under it (the app was opened right on this screen).
// A form closes with ✕, a page goes back with an arrow.
export function backButton(href = '#/', { modal = false } = {}) {
  const button = el('a', {
    class: `icon-button${modal ? '' : ' back-button'}`, href, 'data-back': true, 'aria-label': modal ? 'Закрыть' : 'Назад',
  });
  if (modal) button.textContent = '✕';
  else button.innerHTML = BACK_ICON;
  return button;
}

export function formHead(title, { href = '#/', right = null, modal = false } = {}) {
  return el('header', { class: 'form-head' },
    backButton(href, { modal }),
    el('h1', {}, title),
    right ?? el('span', {}));
}

export function savedScreen(view, { label, number, hint, facts = [], actions }) {
  setLeaveGuard(null);
  view.replaceChildren(el('div', { class: 'saved' },
    el('p', { class: 'saved-label' }, label),
    number != null && el('p', { class: 'saved-number', 'data-testid': 'saved-number' }, `№${number}`),
    hint && el('p', { class: 'saved-hint' }, hint),
    facts.length > 0 && el('dl', { class: 'saved-facts' }, facts.flatMap(([term, value]) => [el('dt', {}, term), el('dd', {}, value)])),
    el('div', { class: 'saved-actions' }, actions)));
}

// The form's entry is left behind: back from the next screen does not reopen it.
export function doneLink(href = '#/') {
  return el('a', { class: 'button button-primary', href, 'data-back': true }, 'Готово');
}

// Runs a ledger write; warnings are asked one by one and the write is repeated.
export async function withConfirmations(run) {
  const confirmed = [];
  for (;;) {
    try {
      return await run({ confirmed: [...confirmed] });
    } catch (error) {
      if (!(error instanceof LedgerError) || error.kind !== 'needs_confirmation') throw error;
      for (const issue of error.issues) {
        const accepted = await confirmSheet({ title: issue.title, amount: issue.amount, message: issue.message });
        if (!accepted) return null;
        confirmed.push(issue.code);
      }
    }
  }
}

export function firstIssue(error) {
  if (error instanceof LedgerError) return error.issues[0]?.message ?? error.message;
  console.error(error);
  return 'Не удалось сохранить. Попробуйте ещё раз.';
}
