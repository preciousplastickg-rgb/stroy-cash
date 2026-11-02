// Transfer between accounts; different currencies make it an exchange with two
// amounts and the rate calculated from them (SPEC §5.5).
import { db, getSettings } from '../db.js';
import {
  accountBalance, allBalances, createTransfer, isMoneyAccount, personName, sortAccounts, updateTransaction,
} from '../ledger.js';
import {
  amountToTyping, formatMoney, formatRate, parseAmount, rateFromAmounts, todayIso,
} from '../money.js';
import { attachAmountInput } from '../ui/amount-input.js';
import { el } from '../ui/dom.js';
import { amountBox, dateRow, doneLink, firstIssue, formHead, formRow, savedScreen, withConfirmations } from '../ui/form.js';
import { openPicker } from '../ui/picker.js';

export function renderTransfer({ view, params, isCurrent }) {
  const editingId = params?.get('edit') ?? null;
  const state = { from_id: params?.get('from') ?? null, to_id: null, date: todayIso() };
  const refs = {};
  const form = el('div', { class: 'form-body' });
  const error = el('p', { class: 'field-error', hidden: true });
  const amount = amountBox({ id: 'transfer-amount', onChange: () => updateRate() });
  const toAmountInput = el('input', { class: 'row-input wide', id: 'transfer-to-amount', type: 'text', inputMode: 'decimal', autocomplete: 'off', 'aria-label': 'Зачислено' });
  const feeInput = el('input', { class: 'row-input wide', id: 'transfer-fee', type: 'text', inputMode: 'decimal', autocomplete: 'off', placeholder: 'Нет', 'aria-label': 'Комиссия' });
  const rateNote = el('span', { class: 'row-note', 'data-testid': 'exchange-rate' });
  const comment = el('input', { class: 'input', type: 'text', placeholder: 'Комментарий', autocomplete: 'off', 'aria-label': 'Комментарий' });
  const saveButton = el('button', { class: 'button button-primary button-save', type: 'button', onClick: save }, editingId ? 'Сохранить изменения' : 'Перевести');

  attachAmountInput(toAmountInput, () => updateRate());
  attachAmountInput(feeInput);

  const from = () => refs.accounts?.find((row) => row.id === state.from_id) ?? null;
  const to = () => refs.accounts?.find((row) => row.id === state.to_id) ?? null;
  const isExchange = () => Boolean(from() && to()) && from().currency !== to().currency;
  const accountLabel = (row) => (row?.type === 'imprest' ? personName(row) : row?.name);

  function updateRate() {
    error.hidden = true;
    const sent = parseAmount(amount.input.value);
    const received = parseAmount(toAmountInput.value);
    rateNote.textContent = isExchange() && sent && received
      ? `Курс ${formatRate(from().currency === 'KGS' ? rateFromAmounts(sent, received) : rateFromAmounts(received, sent))}`
      : '';
  }

  function render() {
    const source = from();
    const target = to();
    amount.setCurrency(source?.currency);
    form.replaceChildren(el('div', { class: 'form-rows' },
      formRow({ name: 'account_id', label: 'Откуда', value: accountLabel(source), note: source ? formatMoney(refs.balances.get(source.id), source.currency) : null, placeholder: 'Выберите счёт', onClick: () => pick('from_id', 'Откуда') }),
      formRow({ name: 'to_account_id', label: 'Куда', value: accountLabel(target), note: target ? formatMoney(refs.balances.get(target.id), target.currency) : null, placeholder: 'Выберите счёт', onClick: () => pick('to_id', 'Куда') }),
      isExchange() && el('label', { class: 'form-row', 'data-name': 'to_amount' },
        el('span', { class: 'row-label' }, `Зачислено, ${target.currency === 'USD' ? '$' : 'сом'}`), toAmountInput, rateNote),
      !editingId && el('label', { class: 'form-row', 'data-name': 'fee' }, el('span', { class: 'row-label' }, 'Комиссия'), feeInput),
      dateRow({
        name: 'date',
        label: 'Дата',
        value: state.date,
        max: todayIso(),
        onChange: (value) => {
          state.date = value ?? todayIso();
          render();
        },
      })), comment);
    updateRate();
  }

  async function pick(key, title) {
    const other = key === 'from_id' ? state.to_id : state.from_id;
    const picked = await openPicker({
      title,
      items: refs.accounts.filter((row) => row.id !== other).map((row) => ({
        id: row.id,
        label: accountLabel(row),
        sub: formatMoney(refs.balances.get(row.id), row.currency),
        group: row.type === 'imprest' ? 'Люди' : 'Счета и касса',
      })),
      selectedId: state[key],
    });
    if (picked) {
      state[key] = picked;
      render();
    }
  }

  async function save() {
    error.hidden = true;
    const exchange = isExchange();
    const draft = {
      date: state.date,
      account_id: state.from_id,
      to_account_id: state.to_id,
      amount: parseAmount(amount.input.value),
      to_amount: exchange ? parseAmount(toAmountInput.value) : undefined,
      rate: !exchange && from()?.currency === 'USD' ? refs.lastRate : undefined,
      fee: parseAmount(feeInput.value) ?? 0,
      description: comment.value.trim(),
    };
    try {
      const row = await withConfirmations((options) => (editingId ? updateTransaction(editingId, { ...draft, fee: undefined }, options) : createTransfer(draft, options)));
      if (!row || !isCurrent()) return;
      const source = from();
      const target = to();
      savedScreen(view, {
        label: editingId ? 'Изменено. Номер операции' : `${exchange ? 'Обмен' : 'Перевод'} сохранён. Номер операции`,
        number: row.number,
        facts: [
          [`Остаток, ${accountLabel(source)}`, formatMoney(await accountBalance(source.id), source.currency)],
          [`Остаток, ${accountLabel(target)}`, formatMoney(await accountBalance(target.id), target.currency)],
        ],
        actions: [doneLink(editingId ? `#/tx?id=${editingId}` : '#/')],
      });
    } catch (failure) {
      error.textContent = firstIssue(failure);
      error.hidden = false;
    }
  }

  view.replaceChildren(formHead(editingId ? 'Изменить перевод' : 'Перевод'), amount.box, error, form, el('div', { class: 'save-bar' }, saveButton));
  if (!editingId) amount.input.focus();

  async function load() {
    const [accounts, balances, settings, editing] = await Promise.all([
      db.accounts.toArray(), allBalances(), getSettings(), editingId ? db.transactions.get(editingId) : null,
    ]);
    if (!isCurrent()) return;
    refs.accounts = sortAccounts(accounts.filter((row) => isMoneyAccount(row) && !row.is_archived));
    refs.balances = balances;
    refs.lastRate = settings.last_usd_rate;
    if (editing) {
      Object.assign(state, { from_id: editing.account_id, to_id: editing.to_account_id, date: editing.date });
      amount.input.value = amountToTyping(editing.amount);
      toAmountInput.value = amountToTyping(editing.to_amount);
      comment.value = editing.description;
    } else if (params?.get('from')) {
      state.to_id = refs.accounts.find((row) => row.type === 'cash' && row.currency === 'KGS')?.id ?? null;
    }
    render();
  }

  load();
}
