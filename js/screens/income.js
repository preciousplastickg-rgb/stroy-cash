// Income: amount, what for, where the money came from, into which account. Money from
// the founder or a loan is a debt of the company. Money from the cash desk is already
// counted there, so it is a transfer, not new money (SPEC §5.4).
import { db, getSettings } from '../db.js';
import {
  INCOME_SOURCES, accountBalance, allBalances, createIncome, createTransfer, ensureCounterparty, isMoneyAccount, isOwedSource,
  shortName, sortAccounts, updateTransaction,
} from '../ledger.js';
import { amountToTyping, formatMoney, formatRate, parseAmount, parseRate, todayIso } from '../money.js';
import { setLeaveGuard } from '../nav.js';
import { el } from '../ui/dom.js';
import { amountBox, dateRow, doneLink, firstIssue, formHead, formRow, savedScreen, withConfirmations } from '../ui/form.js';
import { openPicker } from '../ui/picker.js';

const CUSTOMER_MONEY = /^оплата (заказчика|за квартиры)/i;

export function renderIncome({ view, params, isCurrent }) {
  const editingId = params?.get('edit') ?? null;
  const state = {
    account_id: null, category_id: null, category_text: '', object_id: null, counterparty_id: null, date: todayIso(), rate: null,
    source_kind: 'customer', due_date: null, from_id: null,
  };
  const refs = {};
  const form = el('div', { class: 'form-body' });
  const error = el('p', { class: 'field-error', hidden: true });
  const amount = amountBox({ id: 'income-amount', onChange: () => hideError() });
  const comment = el('input', { class: 'input', type: 'text', placeholder: 'Комментарий', autocomplete: 'off', 'aria-label': 'Комментарий' });
  const rateInput = el('input', {
    class: 'row-input', type: 'text', inputMode: 'decimal', autocomplete: 'off', 'aria-label': 'Курс к сому',
    onInput: () => {
      state.rate = parseRate(rateInput.value);
    },
  });
  const saveButton = el('button', { class: 'button button-primary button-save', type: 'button', onClick: save }, editingId ? 'Сохранить изменения' : 'Сохранить');

  const account = () => refs.accounts?.find((row) => row.id === state.account_id) ?? null;
  const fromAccount = () => refs.accounts?.find((row) => row.id === state.from_id) ?? null;
  const isFromCash = () => !editingId && state.source_kind === 'company';

  // The two ends of a transfer must differ and share a currency.
  function keepTargetValid() {
    if (!isFromCash()) return;
    const from = fromAccount();
    const fits = (row) => row.id !== state.from_id && row.currency === from?.currency;
    if (!account() || !fits(account())) state.account_id = refs.accounts.find(fits)?.id ?? null;
  }

  function hideError() {
    error.hidden = true;
  }

  function render() {
    const current = account();
    const category = refs.categories.find((row) => row.id === state.category_id);
    const source = INCOME_SOURCES.find((row) => row.code === state.source_kind);
    amount.setCurrency(current?.currency);
    form.replaceChildren(...[el('section', { class: 'form-chips', 'data-name': 'source_kind' },
      el('p', { class: 'chips-label' }, 'Откуда деньги'),
      el('div', { class: 'chips-wrap' }, INCOME_SOURCES.map((row) => el('button', {
        class: `chip${row.code === state.source_kind ? ' selected' : ''}`,
        type: 'button',
        'aria-pressed': String(row.code === state.source_kind),
        'data-source': row.code,
        onClick: () => setSource(row.code),
      }, row.label)))),
    isOwedSource(state.source_kind) && el('p', { class: 'plan-note', 'data-testid': 'owed-note' }, 'Это долг компании. Он появится в «Мы должны», пока деньги не вернут.'),
    isFromCash() && fromAccount() && el('p', { class: 'plan-note', 'data-testid': 'cash-note' }, `Деньги уйдут со счёта «${fromAccount().name}». Всего денег у компании не изменится.`),
    el('div', { class: 'form-rows' },
      isFromCash() && formRow({
        name: 'from_account_id',
        label: 'С какого счёта',
        value: fromAccount()?.name,
        note: fromAccount() ? formatMoney(refs.balances.get(fromAccount().id), fromAccount().currency) : null,
        placeholder: 'Выберите счёт',
        onClick: pickFrom,
      }),
      formRow({
        name: 'category_id', label: 'За что', value: category ? shortName(category.name) : state.category_text, placeholder: isFromCash() ? 'Необязательно' : 'Выберите статью', onClick: pickCategory,
      }),
      formRow({
        name: 'object_id',
        label: 'Объект',
        value: refs.objects.find((row) => row.id === state.object_id)?.label,
        placeholder: category?.code === 'customer_payment' ? 'Обязательно' : 'Необязательно',
        onClick: pickObject,
      }),
      source.person && formRow({
        name: 'counterparty_id',
        label: source.person,
        value: refs.counterparties.find((row) => row.id === state.counterparty_id)?.label,
        placeholder: isOwedSource(state.source_kind) ? 'Обязательно' : 'Необязательно',
        onClick: pickCounterparty,
      }),
      isOwedSource(state.source_kind) && dateRow({
        name: 'due_date',
        label: 'Отдать до',
        value: state.due_date,
        placeholder: 'Срок не указан',
        onChange: (value) => {
          state.due_date = value;
          render();
        },
      }),
      formRow({ name: 'account_id', label: 'На счёт', value: current?.name, note: current ? formatMoney(refs.balances.get(current.id), current.currency) : null, placeholder: 'Выберите счёт', onClick: pickAccount }),
      current?.currency === 'USD' && el('label', { class: 'form-row', 'data-name': 'rate' }, el('span', { class: 'row-label' }, 'Курс к сому'), rateInput),
      dateRow({
        name: 'date',
        label: 'Дата',
        value: state.date,
        max: todayIso(),
        onChange: (value) => {
          state.date = value ?? todayIso();
          render();
        },
      })), comment].filter(Boolean));
  }

  function setSource(code) {
    state.source_kind = code;
    if (!INCOME_SOURCES.find((row) => row.code === code).person) state.counterparty_id = null;
    keepTargetValid();
    render();
  }

  async function pickFrom() {
    const picked = await openPicker({
      title: 'С какого счёта',
      items: refs.accounts.map((row) => ({ id: row.id, label: row.name, sub: formatMoney(refs.balances.get(row.id), row.currency) })),
      selectedId: state.from_id,
    });
    if (!picked) return;
    state.from_id = picked;
    keepTargetValid();
    render();
  }

  async function pickCategory() {
    const picked = await openPicker({
      title: 'За что',
      items: refs.categories.map((row) => ({ id: row.id, label: shortName(row.name) })),
      selectedId: state.category_id,
      searchPlaceholder: 'Статья поступления',
      canCreate: true,
      createLabel: 'Новая статья',
    });
    if (!picked) return;
    state.category_id = picked.create ? null : picked;
    state.category_text = picked.create ?? '';
    const name = refs.categories.find((row) => row.id === picked)?.name ?? '';
    if (CUSTOMER_MONEY.test(name)) state.source_kind = 'customer';
    render();
  }

  async function pickObject() {
    const picked = await openPicker({ title: 'Объект', items: refs.objects, selectedId: state.object_id });
    if (picked) {
      state.object_id = picked;
      render();
    }
  }

  async function pickCounterparty() {
    const { type } = INCOME_SOURCES.find((item) => item.code === state.source_kind);
    // Money for an apartment comes from its buyer, not from a customer of the object.
    const category = refs.categories.find((row) => row.id === state.category_id)?.name ?? state.category_text;
    const newType = type === 'customer' && /квартир/i.test(category) ? 'buyer' : type;
    const picked = await openPicker({
      title: 'От кого',
      items: refs.counterparties,
      selectedId: state.counterparty_id,
      searchPlaceholder: 'Имя или название',
      canCreate: true,
      createLabel: { buyer: 'Новый покупатель', customer: 'Новый заказчик' }[newType] ?? 'Новый контрагент',
      autofocus: true,
    });
    if (!picked) return;
    if (picked.create) {
      const row = await ensureCounterparty(picked.create, newType);
      if (!refs.counterparties.some((item) => item.id === row.id)) refs.counterparties.push({ id: row.id, label: row.name });
      state.counterparty_id = row.id;
    } else {
      state.counterparty_id = picked;
      const object = refs.lastObjects.get(picked);
      if (!state.object_id && object) state.object_id = object;
    }
    render();
  }

  async function pickAccount() {
    const picked = await openPicker({
      title: 'На счёт',
      items: refs.accounts
        .filter((row) => !isFromCash() || (row.id !== state.from_id && row.currency === fromAccount()?.currency))
        .map((row) => ({ id: row.id, label: row.name, sub: formatMoney(refs.balances.get(row.id), row.currency) })),
      selectedId: state.account_id,
    });
    if (!picked) return;
    state.account_id = picked;
    state.rate = account().currency === 'USD' ? refs.lastRate : null;
    rateInput.value = state.rate ? formatRate(state.rate) : '';
    render();
  }

  async function save() {
    hideError();
    const draft = {
      date: state.date,
      account_id: state.account_id,
      amount: parseAmount(amount.input.value),
      rate: account()?.currency === 'USD' ? state.rate : undefined,
      category_id: state.category_id,
      category_name: state.category_id ? undefined : state.category_text,
      object_id: state.object_id,
      counterparty_id: state.counterparty_id,
      source_kind: state.source_kind,
      due_date: isOwedSource(state.source_kind) ? state.due_date : null,
      description: comment.value.trim(),
    };
    const fromCash = isFromCash();
    const write = (options) => {
      if (editingId) return updateTransaction(editingId, draft, options);
      if (fromCash) return createTransfer({ ...draft, account_id: state.from_id, to_account_id: state.account_id }, options);
      return createIncome(draft, options);
    };
    try {
      const row = await withConfirmations(write);
      if (!row || !isCurrent()) return;
      const current = account();
      const source = fromAccount();
      savedScreen(view, {
        label: editingId ? 'Изменено. Номер операции' : 'Поступление сохранено. Номер операции',
        number: row.number,
        facts: [
          ['Сумма', formatMoney(row.amount, current.currency)],
          [`Остаток, ${current.name}`, formatMoney(await accountBalance(current.id), current.currency)],
          ...(fromCash ? [[`Остаток, ${source.name}`, formatMoney(await accountBalance(source.id), source.currency)]] : []),
        ],
        actions: [doneLink(editingId ? `#/tx?id=${editingId}` : '#/')],
      });
    } catch (failure) {
      error.textContent = firstIssue(failure);
      error.hidden = false;
    }
  }

  view.replaceChildren(
    formHead(editingId ? 'Изменить поступление' : 'Поступление', { modal: true, href: editingId ? `#/tx?id=${editingId}` : '#/' }),
    amount.box,
    error,
    form,
    el('div', { class: 'save-bar' }, saveButton),
  );
  if (!editingId) amount.input.focus();
  setLeaveGuard(() => !editingId && Boolean(amount.input.value || comment.value.trim()));

  async function load() {
    const [accounts, objects, categories, counterparties, balances, settings, incomes, editing] = await Promise.all([
      db.accounts.toArray(), db.objects.toArray(), db.categories.where('kind').equals('income').toArray(), db.counterparties.toArray(),
      allBalances(), getSettings(), db.transactions.orderBy('number').reverse().limit(300).toArray(),
      editingId ? db.transactions.get(editingId) : null,
    ]);
    if (!isCurrent()) return;
    const byLabel = (a, b) => a.label.localeCompare(b.label, 'ru');
    refs.accounts = sortAccounts(accounts.filter((row) => isMoneyAccount(row) && !row.is_archived && row.type !== 'imprest'));
    refs.balances = balances;
    refs.lastRate = settings.last_usd_rate;
    refs.objects = objects.filter((row) => row.status === 'active').map((row) => ({ id: row.id, label: row.name })).sort(byLabel);
    refs.categories = categories.filter((row) => row.parent_id && !row.is_archived).sort((a, b) => a.position - b.position);
    const payers = counterparties.filter((row) => !row.is_archived).sort((a, b) => {
      const rank = (row) => (['buyer', 'customer', 'founder', 'lender'].includes(row.type) ? 0 : 1);
      return rank(a) - rank(b) || a.name.localeCompare(b.name, 'ru');
    });
    refs.counterparties = payers.map((row) => ({ id: row.id, label: row.name, sub: row.note }));
    const received = incomes.filter((tx) => tx.type === 'income' && tx.status === 'posted');
    refs.lastObjects = new Map(received.reverse().filter((tx) => tx.counterparty_id && tx.object_id).map((tx) => [tx.counterparty_id, tx.object_id]));
    state.account_id = received.at(-1)?.account_id ?? refs.accounts.find((row) => row.type === 'bank')?.id ?? refs.accounts[0]?.id ?? null;
    state.from_id = refs.accounts.find((row) => row.type === 'cash' && row.currency === 'KGS')?.id ?? refs.accounts[0]?.id ?? null;
    keepTargetValid();
    if (editing) {
      Object.assign(state, {
        account_id: editing.account_id,
        category_id: editing.category_id,
        object_id: editing.object_id,
        counterparty_id: editing.counterparty_id,
        date: editing.date,
        source_kind: editing.source_kind ?? 'customer',
        due_date: editing.due_date,
        rate: account()?.currency === 'USD' ? editing.rate : null,
      });
      amount.input.value = amountToTyping(editing.amount);
      comment.value = editing.description;
      rateInput.value = state.rate ? formatRate(state.rate) : '';
    }
    render();
  }

  load();
}
