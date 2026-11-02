// Handing money to a person who buys for the company: a transfer to their imprest
// account, not an expense. The money is not spent yet (SPEC §11).
import { db } from '../db.js';
import {
  LedgerError, accountBalance, allBalances, checkTransaction, createPerson, createTransfer, personName, sortAccounts,
} from '../ledger.js';
import { formatMoney, parseAmount, todayIso } from '../money.js';
import { attachAmountInput } from '../ui/amount-input.js';
import { confirmSheet } from '../ui/confirm.js';
import { el } from '../ui/dom.js';
import { openPicker } from '../ui/picker.js';
import { toast } from '../ui/toast.js';

export function renderIssue({ view, params, isCurrent }) {
  const state = { person_id: params?.get('person') ?? null, source_id: null, errors: {} };
  const refs = {};

  const amountInput = el('input', {
    class: 'amount-input', id: 'issue-amount', type: 'text', inputMode: 'decimal', autocomplete: 'off', enterKeyHint: 'done', placeholder: '0', 'aria-label': 'Сумма',
  });
  const amountError = el('p', { class: 'field-error', hidden: true });
  const comment = el('input', { class: 'input', type: 'text', placeholder: 'На что выдаём', autocomplete: 'off', 'aria-label': 'На что выдаём' });
  const form = el('div', { class: 'form-body' });
  const saveButton = el('button', { class: 'button button-primary button-save', type: 'button', onClick: save }, 'Выдать');

  attachAmountInput(amountInput, () => {
    amountError.hidden = true;
  });

  const person = () => refs.people?.find((row) => row.id === state.person_id) ?? null;
  const source = () => refs.sources?.find((row) => row.id === state.source_id) ?? null;

  function row({ name, label, value, placeholder, note, onClick }) {
    return el('button', { class: 'form-row', type: 'button', 'data-name': name, 'data-more': name, onClick },
      el('span', { class: 'row-label' }, label),
      el('span', { class: `row-value${value ? '' : ' empty'}` }, value || placeholder),
      note && el('span', { class: 'row-note' }, note));
  }

  function render() {
    const current = person();
    const from = source();
    form.replaceChildren(...[
      el('div', { class: 'form-rows' },
        row({
          name: 'to_account_id',
          label: 'Кому',
          value: current ? personName(current) : '',
          placeholder: 'Выберите человека',
          note: current ? formatMoney(refs.balances.get(current.id) ?? 0, current.currency) : null,
          onClick: pickPerson,
        }),
        row({
          name: 'account_id',
          label: 'Откуда деньги',
          value: from?.name,
          placeholder: 'Выберите счёт',
          note: from ? formatMoney(refs.balances.get(from.id), from.currency) : null,
          onClick: pickSource,
        })),
      comment,
      state.errors.to_account_id && el('p', { class: 'field-error' }, state.errors.to_account_id),
    ].filter(Boolean));
  }

  async function pickPerson() {
    const picked = await openPicker({
      title: 'Кому выдаём',
      items: refs.people.map((item) => ({ id: item.id, label: personName(item), sub: `На руках ${formatMoney(refs.balances.get(item.id) ?? 0, item.currency)}` })),
      selectedId: state.person_id,
      searchPlaceholder: 'Имя человека',
      canCreate: true,
      createLabel: 'Новый человек',
      autofocus: true,
    });
    if (!picked) return;
    if (picked.create) {
      const created = await createPerson(picked.create);
      if (!refs.people.some((item) => item.id === created.id)) refs.people.push(created);
      state.person_id = created.id;
    } else {
      state.person_id = picked;
    }
    delete state.errors.to_account_id;
    render();
  }

  async function pickSource() {
    const picked = await openPicker({
      title: 'Откуда деньги',
      items: refs.sources.map((item) => ({ id: item.id, label: item.name, sub: formatMoney(refs.balances.get(item.id), item.currency) })),
      selectedId: state.source_id,
    });
    if (picked) {
      state.source_id = picked;
      render();
    }
  }

  function showIssues(errors) {
    state.errors = Object.fromEntries(errors.map((issue) => [issue.field, issue.message]));
    amountError.hidden = !state.errors.amount;
    amountError.textContent = state.errors.amount ?? '';
    render();
  }

  async function save() {
    const draft = {
      type: 'transfer',
      date: todayIso(),
      account_id: state.source_id,
      to_account_id: state.person_id,
      amount: parseAmount(amountInput.value),
      description: comment.value.trim() || 'Выдача под закупку',
    };
    const { errors, warnings } = await checkTransaction(draft);
    if (errors.length > 0) {
      showIssues(errors);
      return;
    }
    for (const warning of warnings) {
      if (!(await confirmSheet({ title: warning.title, amount: warning.amount, message: warning.message }))) return;
    }
    try {
      const saved = await createTransfer(draft, { confirmed: warnings.map((warning) => warning.code) });
      await showDone(saved);
    } catch (error) {
      if (!(error instanceof LedgerError)) throw error;
      toast(error.message);
    }
  }

  async function showDone(saved) {
    const current = person();
    const balance = await accountBalance(current.id);
    if (!isCurrent()) return;
    view.replaceChildren(el('div', { class: 'saved' },
      el('p', { class: 'saved-label' }, 'Выдано. Номер операции'),
      el('p', { class: 'saved-number', 'data-testid': 'saved-number' }, `№${saved.number}`),
      el('dl', { class: 'saved-facts' },
        el('dt', {}, 'Сумма'), el('dd', {}, formatMoney(saved.amount, current.currency)),
        el('dt', {}, `На руках, ${personName(current)}`), el('dd', {}, formatMoney(balance, current.currency))),
      el('div', { class: 'saved-actions' },
        el('a', { class: 'button button-primary', href: `#/person?id=${current.id}` }, 'Готово'))));
  }

  view.replaceChildren(
    el('header', { class: 'form-head' },
      el('a', { class: 'icon-button', href: '#/', 'aria-label': 'Закрыть' }, '✕'),
      el('h1', {}, 'Выдать деньги'),
      el('span', {})),
    el('div', { class: 'amount-box' }, amountInput, el('span', { class: 'amount-currency' }, 'сом')),
    amountError,
    form,
    el('div', { class: 'save-bar' }, saveButton),
  );
  amountInput.focus();

  async function load() {
    const [accounts, balances] = await Promise.all([db.accounts.toArray(), allBalances()]);
    if (!isCurrent()) return;
    const sorted = sortAccounts(accounts.filter((account) => !account.is_archived && account.currency === 'KGS'));
    refs.people = sorted.filter((account) => account.type === 'imprest');
    refs.sources = sorted.filter((account) => account.type !== 'imprest' && account.type !== 'barter');
    refs.balances = balances;
    state.source_id = refs.sources[0]?.id ?? null;
    render();
  }

  load();
}
