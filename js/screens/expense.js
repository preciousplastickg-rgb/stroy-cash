// Expense form, the main scenario: 30 seconds and at most 6 taps. One choice does
// most of the work: picking what was bought from the recent list fills the object
// and the supplier. Everything else is a short row that opens only when needed.
import { db, getSettings } from '../db.js';
import { goBack, replaceParams, setLeaveGuard } from '../nav.js';
import {
  DOC_TYPES, LedgerError, MAX_PHOTOS, accountBalance, allBalances, cancelPlannedExpense, checkTransaction,
  COUNTERPARTY_GROUPS, counterpartyDefaults, createDebt, createExpense, createPerson, createPlannedExpense,
  isMoneyAccount, payPlannedExpense, personName, recentExpenseChoices, shortName, sortAccounts, updatePlannedExpense,
  updateTransaction,
} from '../ledger.js';
import {
  amountToTyping, computeAmountKgs, formatDate, formatMoney, formatRate, parseAmount, parseRate, todayIso,
} from '../money.js';
import { attachAmountInput } from '../ui/amount-input.js';
import { confirmSheet } from '../ui/confirm.js';
import { el } from '../ui/dom.js';
import { backButton, dateRow } from '../ui/form.js';
import { compressPhoto } from '../ui/photo.js';
import { openPicker } from '../ui/picker.js';
import { toast } from '../ui/toast.js';

const RECENT_ROWS = 4;
const OBJECT_CHIPS = 4;
const DOC_CHIPS = 4;
const DIRECT = 'direct';
const NEW_COUNTERPARTY_TYPES = [
  { type: 'supplier', label: 'Поставщик' },
  { type: 'contractor', label: 'Подрядчик' },
  { type: 'service', label: 'Услуги' },
];
const FIELD_ORDER = ['amount', 'rate', 'category_id', 'object_id', 'account_id', 'due_date', 'doc_type', 'date'];

const byLabel = (a, b) => a.label.localeCompare(b.label, 'ru');

function freshState() {
  return {
    mode: 'paid',
    account_id: null,
    source_account_id: null,
    rate: null,
    object_id: null,
    category_id: null,
    category_text: '',
    counterparty_id: null,
    counterparty_text: '',
    counterparty_type: null,
    doc_type: null,
    date: todayIso(),
    due_date: null,
    photos: [],
    stored_photos: 0,
    errors: {},
    saving: false,
  };
}

function chip({ label, selected = false, onClick, field }) {
  return el('button', {
    class: `chip${selected ? ' selected' : ''}`, type: 'button', 'aria-pressed': String(selected), 'data-field': field, onClick,
  }, label);
}

export function renderExpense({ view, isCurrent, params }) {
  const state = freshState();
  const refs = {};
  let payingId = params?.get('planned') ?? null;
  const editingId = params?.get('edit') ?? null;
  const instanceId = params?.get('instance') ?? null;
  let plan = null;

  const amountInput = el('input', {
    class: 'amount-input',
    id: 'expense-amount',
    type: 'text',
    inputMode: 'decimal',
    autocomplete: 'off',
    enterKeyHint: 'done',
    placeholder: '0',
    'aria-label': 'Сумма',
    onKeydown: (event) => {
      if (event.key === 'Enter') amountInput.blur();
    },
  });
  const currencyLabel = el('span', { class: 'amount-currency' }, 'сом');
  const amountError = el('p', { class: 'field-error', hidden: true });
  const dateLabel = el('span', {}, 'Сегодня');
  const dateInput = el('input', {
    class: 'date-input', type: 'date', value: state.date, max: payingId || editingId || instanceId ? state.date : null, 'aria-label': 'Дата операции',
    onChange: () => {
      state.date = dateInput.value || todayIso();
      delete state.errors.date;
      renderForm();
    },
  });
  const title = el('h1', {}, editingId ? 'Изменить расход' : payingId || instanceId ? 'Оплата' : 'Расход');
  const dueInput = el('input', {
    class: 'date-input', type: 'date', 'aria-label': 'Отдать до',
    onChange: () => {
      state.due_date = dueInput.value || null;
      delete state.errors.due_date;
      renderKeepingScroll();
    },
  });
  const planNote = el('p', { class: 'plan-note', hidden: true }, 'Деньги не спишутся, пока вы не оплатите этот расход.');
  const form = el('div', { class: 'form-body' });
  const saveButton = el('button', { class: 'button button-primary button-save', type: 'button', onClick: save }, 'Сохранить');
  const rateInput = el('input', {
    class: 'row-input', type: 'text', inputMode: 'decimal', autocomplete: 'off', 'aria-label': 'Курс к сому',
    onInput: () => {
      state.rate = parseRate(rateInput.value);
      clearError('rate');
      updateConversion();
    },
  });
  const conversion = el('span', { class: 'rate-result' });
  const docNumber = el('input', { class: 'input', type: 'text', placeholder: 'Номер', autocomplete: 'off', 'aria-label': 'Номер документа' });
  const comment = el('input', { class: 'input', type: 'text', placeholder: 'Комментарий', autocomplete: 'off', 'aria-label': 'Комментарий' });

  attachAmountInput(amountInput, () => {
    clearError('amount');
    updateConversion();
  });

  const account = () => refs.accounts?.find((row) => row.id === state.account_id) ?? null;
  const byId = (rows, id) => rows.find((row) => row.id === id);
  const isDebt = () => state.mode === 'debt';
  const isPlanning = () => !payingId && !editingId && !isDebt() && state.date > todayIso();
  const isPerson = (row) => row?.type === 'imprest';
  const needsDocument = () => !isDebt() && !isPlanning();

  function saveLabel() {
    if (editingId) return 'Сохранить изменения';
    if (payingId || instanceId) return 'Оплатить';
    if (isDebt()) return 'Записать долг';
    return isPlanning() ? 'Запланировать' : 'Сохранить';
  }

  function updateConversion() {
    const current = account();
    const amount = parseAmount(amountInput.value);
    conversion.textContent = current?.currency === 'USD' && amount && state.rate
      ? formatMoney(computeAmountKgs({ currency: 'USD', amount, rate: state.rate }), 'KGS')
      : '';
  }

  function clearError(name) {
    delete state.errors[name];
    showErrors();
  }

  function showErrors() {
    amountError.hidden = !state.errors.amount;
    amountError.textContent = state.errors.amount ?? '';
    amountInput.closest('.amount-box')?.classList.toggle('invalid', Boolean(state.errors.amount));
    for (const node of form.querySelectorAll('[data-name]')) {
      const message = state.errors[node.dataset.name];
      node.classList.toggle('invalid', Boolean(message));
      const line = node.querySelector('.field-error');
      if (!line) continue;
      line.hidden = !message;
      line.textContent = message ?? '';
    }
  }

  function modeSwitch() {
    const option = (mode, label) => el('button', {
      class: `segment${state.mode === mode ? ' selected' : ''}`,
      type: 'button',
      'aria-pressed': String(state.mode === mode),
      'data-mode': mode,
      onClick: () => {
        state.mode = mode;
        delete state.errors.doc_type;
        delete state.errors.date;
        renderKeepingScroll();
      },
    }, label);
    return el('div', { class: 'segments', role: 'group', 'aria-label': 'Оплата' }, option('paid', 'Оплачено'), option('debt', 'В долг'));
  }

  function categoryName() {
    return byId(refs.categoryItems, state.category_id)?.label ?? state.category_text;
  }

  function counterpartyName() {
    return byId(refs.counterpartyItems, state.counterparty_id)?.label ?? state.counterparty_text;
  }

  function comboRow(combo) {
    const objectName = byId(refs.objectItems, combo.object_id).label.split(',')[0];
    const supplier = byId(refs.counterpartyItems, combo.counterparty_id)?.label;
    return el('button', { class: 'combo-row', type: 'button', onClick: () => chooseCombo(combo) },
      el('span', { class: 'combo-title' }, byId(refs.categoryItems, combo.category_id).label),
      el('span', { class: 'combo-sub' }, supplier ? `${objectName}, ${supplier}` : objectName));
  }

  function whatField() {
    const chosen = categoryName();
    if (chosen) {
      return el('section', { 'data-name': 'category_id' },
        el('button', { class: 'what-chosen', type: 'button', 'data-more': 'category_id', onClick: pickCategory },
          el('span', { class: 'what-label' }, 'Что купили'),
          el('span', { class: 'what-value' }, chosen)));
    }
    const combos = refs.recent.combos
      .filter((combo) => byId(refs.objectItems, combo.object_id) && byId(refs.categoryItems, combo.category_id))
      .slice(0, RECENT_ROWS);
    return el('section', { 'data-name': 'category_id' },
      el('button', { class: 'what-search', type: 'button', 'data-more': 'category_id', onClick: pickCategory }, 'Что купили: начните писать'),
      el('p', { class: 'field-error', hidden: true }),
      combos.length > 0 && el('div', { class: 'combo-list' }, combos.map(comboRow)));
  }

  function row({ name, label, value, placeholder, onClick, note }) {
    return el('button', {
      class: 'form-row', type: 'button', 'data-name': name, 'data-more': name, disabled: !onClick, onClick,
    },
    el('span', { class: 'row-label' }, label),
    el('span', { class: `row-value${value ? '' : ' empty'}` }, value || placeholder),
    note && el('span', { class: 'row-note' }, note));
  }

  function objectRow() {
    if (state.object_id) {
      return row({ name: 'object_id', label: 'Объект', value: byId(refs.objectItems, state.object_id).label, onClick: pickObject });
    }
    const order = [...new Set([...refs.recent.object_ids, ...refs.objectItems.map((item) => item.id)])];
    const rows = order.map((id) => byId(refs.objectItems, id)).filter(Boolean);
    return el('section', { class: 'form-chips', 'data-name': 'object_id' },
      el('p', { class: 'chips-label' }, 'Объект'),
      el('div', { class: 'chips-wrap' },
        rows.slice(0, OBJECT_CHIPS).map((item) => chip({
          label: item.label.split(',')[0], field: 'object_id', onClick: () => selectObject(item.id),
        })),
        rows.length > OBJECT_CHIPS && chip({ label: 'Все', field: 'object_id', onClick: pickObject })),
      el('p', { class: 'field-error', hidden: true }));
  }

  function counterpartyRow() {
    const name = counterpartyName();
    const isNew = Boolean(state.counterparty_text) && !state.counterparty_id;
    return [
      row({ name: 'counterparty_id', label: 'У кого', value: name, placeholder: 'Необязательно', onClick: pickCounterparty }),
      isNew && el('div', { class: 'type-row' },
        el('span', { class: 'chips-label' }, 'Кто это'),
        NEW_COUNTERPARTY_TYPES.map(({ type, label }) => chip({
          label,
          selected: state.counterparty_type === type,
          field: 'counterparty_type',
          onClick: () => {
            state.counterparty_type = state.counterparty_type === type ? null : type;
            renderKeepingScroll();
          },
        }))),
    ];
  }

  function moneyRows() {
    const current = account();
    if (payingId && plan?.plan_kind === 'debt' && isPerson(current)) {
      const source = byId(refs.accounts, state.source_account_id);
      return [
        ...debtFacts(),
        row({ name: 'via', label: 'Передать', value: personName(current), onClick: null }),
        row({
          name: 'account_id',
          label: 'Откуда деньги',
          value: isPerson(source) ? 'Уже на руках' : source?.name,
          note: source ? formatMoney(refs.balances.get(source.id), source.currency) : null,
          onClick: pickSource,
        }),
      ];
    }
    if (isDebt()) {
      return [
        row({
          name: 'account_id',
          label: 'Кому передать',
          value: isPerson(current) ? personName(current) : 'Напрямую',
          onClick: pickVia,
        }),
        dueRow(),
      ];
    }
    const planFacts = plan?.plan_kind === 'debt' ? debtFacts() : plan ? [planDateRow()] : [];
    return [...planFacts, row({
      name: 'account_id',
      label: isPerson(current) ? 'Через кого' : 'Откуда деньги',
      value: isPerson(current) ? personName(current) : current?.name,
      placeholder: 'Выберите счёт',
      note: current ? formatMoney(refs.balances.get(current.id), current.currency) : null,
      onClick: pickAccount,
    })];
  }

  function dueRow() {
    return el('label', { class: 'form-row date-row', 'data-name': 'due_date' },
      el('span', { class: 'row-label' }, 'Отдать до'),
      el('span', { class: `row-value${state.due_date ? '' : ' empty'}` }, state.due_date ? formatDate(state.due_date) : 'Срок не указан'),
      dueInput,
      el('span', { class: 'field-error', hidden: true }));
  }

  // On the payment form: when it was taken and when it has to be given.
  function debtFacts() {
    return [row({ name: 'taken', label: 'Взяли', value: formatDate(plan.date), onClick: null }), dueRow()];
  }

  function planDateRow() {
    return dateRow({
      name: 'plan_date',
      label: 'План на',
      value: state.plan_date,
      onChange: (value) => {
        state.plan_date = value ?? plan.date;
        renderKeepingScroll();
      },
    });
  }

  function rateRow() {
    return el('label', { class: 'form-row', 'data-name': 'rate' },
      el('span', { class: 'row-label' }, 'Курс к сому'),
      rateInput,
      conversion);
  }

  function docField() {
    const used = refs.recent.doc_types.filter((code) => code !== 'none');
    const ordered = [...DOC_TYPES.filter((doc) => doc.code !== 'none')]
      .sort((a, b) => (used.indexOf(a.code) + 1 || 99) - (used.indexOf(b.code) + 1 || 99));
    const none = DOC_TYPES.find((doc) => doc.code === 'none');
    const selected = DOC_TYPES.find((doc) => doc.code === state.doc_type);
    const shown = ordered.slice(0, DOC_CHIPS);
    if (selected && selected !== none && !shown.includes(selected)) shown[shown.length - 1] = selected;
    const hasMore = ordered.length > shown.length;
    return el('section', { class: 'form-chips', 'data-name': 'doc_type' },
      el('p', { class: 'chips-label' }, needsDocument() ? 'Документ' : 'Документ, если уже есть'),
      el('div', { class: 'chips-wrap' },
        [...shown, none].map((doc) => chip({
          label: doc.short,
          selected: doc.code === state.doc_type,
          field: 'doc_type',
          onClick: () => selectDoc(doc.code === state.doc_type ? null : doc.code),
        })),
        hasMore && chip({ label: 'Ещё', field: 'doc_type', onClick: pickDoc })),
      el('p', { class: 'field-error', hidden: true }));
  }

  function photoField() {
    const canAdd = state.stored_photos + state.photos.length < MAX_PHOTOS;
    const input = (capture) => el('input', {
      class: 'file-input', type: 'file', accept: 'image/*', capture: capture ? 'environment' : null,
      'data-photo': capture ? 'camera' : 'gallery', onChange: addPhoto,
    });
    return el('section', { class: 'photo-field' },
      el('div', { class: 'photo-actions' },
        canAdd && el('label', { class: 'photo-button' }, input(true), 'Камера'),
        canAdd && el('label', { class: 'photo-button secondary' }, input(false), 'Галерея')),
      state.stored_photos > 0 && el('p', { class: 'chips-label' }, `Уже прикреплено фото: ${state.stored_photos}`),
      state.photos.length > 0 && el('div', { class: 'photo-list' }, state.photos.map((photo) => el('div', { class: 'photo-thumb' },
        el('img', { src: photo.url, alt: 'Фото документа' }),
        el('button', {
          class: 'photo-remove', type: 'button', 'aria-label': 'Убрать фото', onClick: () => removePhoto(photo),
        }, '✕')))));
  }

  function notesRow() {
    const needsNumber = state.doc_type && state.doc_type !== 'none';
    return el('div', { class: `notes-row${needsNumber ? ' with-number' : ''}` }, needsNumber && docNumber, comment);
  }

  function renderForm() {
    if (!refs.accounts) return;
    const current = account();
    form.replaceChildren(...[
      !payingId && !editingId && !instanceId && modeSwitch(),
      whatField(),
      el('div', { class: 'form-rows' },
        objectRow(), counterpartyRow(), moneyRows(), current?.currency === 'USD' && rateRow()),
      docField(),
      photoField(),
      notesRow(),
      payingId && el('button', { class: 'list-action', type: 'button', 'data-action': 'save-plan', onClick: savePlanChanges }, 'Сохранить без оплаты'),
      payingId && el('button', { class: 'list-action danger', type: 'button', onClick: cancelPlan }, 'Отменить'),
    ].filter(Boolean));
    currencyLabel.textContent = current?.currency === 'USD' ? '$' : 'сом';
    dateLabel.textContent = state.date === todayIso() ? 'Сегодня' : formatDate(state.date);
    planNote.hidden = !isPlanning();
    saveButton.textContent = saveLabel();
    updateConversion();
    showErrors();
  }

  function renderKeepingScroll() {
    const scroller = view.scrollTop;
    renderForm();
    view.scrollTop = scroller;
  }

  function chooseCombo(combo) {
    state.category_id = combo.category_id;
    state.category_text = '';
    state.object_id = combo.object_id;
    state.counterparty_id = combo.counterparty_id;
    state.counterparty_text = '';
    delete state.errors.category_id;
    delete state.errors.object_id;
    renderKeepingScroll();
  }

  function selectObject(id) {
    state.object_id = id;
    delete state.errors.object_id;
    renderKeepingScroll();
  }

  function selectDoc(code) {
    state.doc_type = code;
    delete state.errors.doc_type;
    renderKeepingScroll();
  }

  // What the last purchase of this article went to fills the gaps, nothing more.
  function fillFromHistory(categoryId) {
    const known = refs.recent.combos.find((combo) => combo.category_id === categoryId);
    if (!known) return;
    if (!state.object_id && byId(refs.objectItems, known.object_id)) state.object_id = known.object_id;
    if (!state.counterparty_id && !state.counterparty_text) state.counterparty_id = known.counterparty_id;
  }

  async function pickCategory() {
    const picked = await openPicker({
      title: 'Что купили',
      items: refs.categoryItems,
      recentIds: refs.recent.category_ids.slice(0, RECENT_ROWS),
      selectedId: state.category_id,
      searchPlaceholder: 'Товар или услуга',
      canCreate: true,
      createLabel: 'Новая статья',
      autofocus: true,
    });
    if (!picked) return;
    delete state.errors.category_id;
    if (picked.create) {
      state.category_id = null;
      state.category_text = picked.create;
    } else {
      state.category_id = picked;
      state.category_text = '';
      fillFromHistory(picked);
    }
    renderKeepingScroll();
  }

  async function pickObject() {
    const id = await openPicker({
      title: 'Объект', items: refs.objectItems, recentIds: refs.recent.object_ids, selectedId: state.object_id,
    });
    if (id) selectObject(id);
  }

  // Filled gaps only: what the user already chose stays (SPEC §5.3).
  async function selectCounterparty(id) {
    state.counterparty_id = id;
    state.counterparty_text = '';
    const defaults = await counterpartyDefaults(id);
    if (!state.object_id) state.object_id = defaults?.object_id ?? null;
    if (!categoryName()) state.category_id = defaults?.category_id ?? null;
    delete state.errors.object_id;
    delete state.errors.category_id;
    renderKeepingScroll();
  }

  async function pickCounterparty() {
    const picked = await openPicker({
      title: 'У кого купили',
      items: refs.counterpartyItems,
      recentIds: refs.recent.counterparty_ids.slice(0, RECENT_ROWS),
      selectedId: state.counterparty_id,
      searchPlaceholder: 'Компания, подрядчик или человек',
      canCreate: true,
      createLabel: 'Новый контрагент',
      autofocus: true,
    });
    if (!picked) return;
    if (picked.create) {
      state.counterparty_id = null;
      state.counterparty_text = picked.create;
      renderKeepingScroll();
    } else {
      await selectCounterparty(picked);
    }
  }

  function moneyItems(accounts) {
    return accounts.map((row) => (isPerson(row)
      ? { id: row.id, label: personName(row), sub: `На руках ${formatMoney(refs.balances.get(row.id), row.currency)}`, group: 'Через человека' }
      : { id: row.id, label: row.name, sub: formatMoney(refs.balances.get(row.id), row.currency), group: 'Счета и касса' }));
  }

  function useAccount(id) {
    state.account_id = id;
    state.rate = account().currency === 'USD' ? refs.lastRate : null;
    rateInput.value = state.rate ? formatRate(state.rate) : '';
    // The amount error may be the balance of the previous account.
    delete state.errors.amount;
    delete state.errors.account_id;
    delete state.errors.rate;
    renderKeepingScroll();
  }

  async function addPerson(name) {
    const person = await createPerson(name);
    if (!byId(refs.accounts, person.id)) refs.accounts = sortAccounts([...refs.accounts, person]);
    refs.balances.set(person.id, refs.balances.get(person.id) ?? 0);
    return person.id;
  }

  async function pickAccount() {
    const picked = await openPicker({
      title: 'Откуда деньги',
      items: moneyItems(refs.accounts),
      selectedId: state.account_id,
      searchPlaceholder: 'Счёт или человек',
      canCreate: true,
      createLabel: 'Новый человек',
    });
    if (picked) useAccount(picked.create ? await addPerson(picked.create) : picked);
  }

  async function pickVia() {
    const people = moneyItems(refs.accounts.filter(isPerson));
    const current = account();
    const picked = await openPicker({
      title: 'Через кого',
      items: [{ id: DIRECT, label: 'Напрямую', sub: 'Заплатим сами, без посредника', group: 'Без посредника' }, ...people],
      selectedId: isPerson(current) ? current.id : DIRECT,
      searchPlaceholder: 'Имя человека',
      canCreate: true,
      createLabel: 'Новый человек',
    });
    if (!picked) return;
    if (picked === DIRECT) useAccount(refs.accounts.find((row) => !isPerson(row)).id);
    else useAccount(picked.create ? await addPerson(picked.create) : picked);
  }

  async function pickSource() {
    const items = moneyItems(refs.accounts.filter((row) => row.currency === account().currency && (!isPerson(row) || row.id === state.account_id)));
    const picked = await openPicker({ title: 'Откуда деньги', items, selectedId: state.source_account_id });
    if (picked) {
      state.source_account_id = picked;
      delete state.errors.amount;
      renderKeepingScroll();
    }
  }

  async function pickDoc() {
    const picked = await openPicker({
      title: 'Документ',
      items: DOC_TYPES.map((doc) => ({ id: doc.code, label: doc.label })),
      selectedId: state.doc_type,
    });
    if (picked) selectDoc(picked);
  }

  async function addPhoto(event) {
    const [file] = event.target.files;
    if (!file) return;
    const job = compressPhoto(file);
    state.photoJob = job;
    try {
      const blob = await job;
      state.photos.push({ blob, url: URL.createObjectURL(blob) });
      renderKeepingScroll();
      form.querySelector('.photo-list')?.scrollIntoView({ block: 'nearest' });
    } catch (error) {
      toast(error.message);
    }
  }

  function removePhoto(photo) {
    URL.revokeObjectURL(photo.url);
    state.photos = state.photos.filter((item) => item !== photo);
    renderKeepingScroll();
  }

  function draft() {
    const current = account();
    return {
      type: 'expense',
      date: state.date,
      account_id: state.account_id,
      amount: parseAmount(amountInput.value),
      rate: current?.currency === 'USD' ? state.rate : undefined,
      object_id: state.object_id,
      category_id: state.category_id,
      category_name: state.category_id ? undefined : state.category_text,
      counterparty_id: state.counterparty_id,
      counterparty_name: state.counterparty_id ? undefined : state.counterparty_text,
      counterparty_type: state.counterparty_type,
      status: !payingId && (isPlanning() || isDebt()) ? 'planned' : undefined,
      plan_kind: !payingId && isDebt() ? 'debt' : undefined,
      recurring_instance_id: instanceId ?? undefined,
      due_date: !payingId && isDebt() ? state.due_date : undefined,
      doc_type: state.doc_type,
      doc_number: state.doc_type && state.doc_type !== 'none' ? docNumber.value.trim() : '',
      description: comment.value.trim(),
    };
  }

  function showIssues(issues) {
    state.errors = {};
    for (const issue of issues) state.errors[issue.field] = issue.message;
    showErrors();
    if (state.errors.date) toast(state.errors.date);
    const first = FIELD_ORDER.find((name) => state.errors[name]);
    if (first === 'amount') view.scrollTop = 0;
    else form.querySelector(`[data-name="${first}"]`)?.scrollIntoView({ block: 'center' });
  }

  async function askConfirmations(warnings) {
    for (const warning of warnings) {
      const accepted = await confirmSheet({ title: warning.title, amount: warning.amount, message: warning.message });
      if (!accepted) return false;
    }
    return true;
  }

  async function write(values, options) {
    if (editingId) return showSaved(await updateTransaction(editingId, values, options));
    if (payingId) return showSaved(await payPlannedExpense(payingId, values, { ...options, sourceAccountId: state.source_account_id }));
    if (isDebt()) return showDebt(await createDebt(values, options));
    if (isPlanning()) return showPlanned(await createPlannedExpense(values, options));
    return showSaved(await createExpense(values, options));
  }

  async function save() {
    if (state.saving) return;
    state.saving = true;
    saveButton.disabled = true;
    try {
      await state.photoJob?.catch(() => {});
      const values = draft();
      // When the money is handed to a person first, its source is what gets checked.
      const checked = payingId && state.source_account_id ? { ...values, account_id: state.source_account_id } : values;
      const { errors, warnings } = await checkTransaction(checked);
      if (errors.length > 0) {
        showIssues(errors);
        return;
      }
      if (!(await askConfirmations(warnings))) return;
      await write(values, {
        confirmed: warnings.map((warning) => warning.code),
        photos: state.photos.map((photo) => photo.blob),
      });
    } catch (error) {
      if (error instanceof LedgerError && error.kind === 'invalid') {
        showIssues(error.issues);
      } else if (error instanceof LedgerError) {
        toast(error.message);
      } else {
        console.error(error);
        toast('Не удалось сохранить. Данные формы на месте, попробуйте ещё раз.');
      }
    } finally {
      state.saving = false;
      saveButton.disabled = false;
    }
  }

  // A plan or a debt changes without paying: same fields, no money moves.
  async function savePlanChanges() {
    const values = {
      ...draft(),
      date: plan.plan_kind === 'debt' ? plan.date : state.plan_date,
      due_date: plan.plan_kind === 'debt' ? state.due_date : undefined,
      doc_type: state.doc_type,
      status: undefined,
    };
    try {
      await updatePlannedExpense(payingId, values, { confirmed: ['large_amount', 'rate_jump'], photos: state.photos.map((photo) => photo.blob) });
      toast('Изменения сохранены');
      goBack('/');
    } catch (error) {
      if (!(error instanceof LedgerError)) throw error;
      showIssues(error.issues);
    }
  }

  function finish(...content) {
    setLeaveGuard(null);
    for (const photo of state.photos) URL.revokeObjectURL(photo.url);
    view.replaceChildren(el('div', { class: 'saved' }, ...content, savedActions()));
  }

  async function showSaved(row) {
    const current = account();
    const balance = await accountBalance(current.id);
    if (!isCurrent()) return;
    finish(
      el('p', { class: 'saved-label' }, editingId ? 'Изменено. Номер операции' : 'Сохранено. Номер операции'),
      el('p', { class: 'saved-number', 'data-testid': 'saved-number' }, `№${row.number}`),
      el('p', { class: 'saved-hint' }, 'Напишите этот номер ручкой на документе'),
      el('dl', { class: 'saved-facts' },
        el('dt', {}, 'Сумма'), el('dd', {}, formatMoney(row.amount, current.currency)),
        el('dt', {}, isPerson(current) ? `На руках, ${personName(current)}` : `Остаток, ${current.name}`),
        el('dd', {}, formatMoney(balance, current.currency))),
    );
  }

  function showPlanned(row) {
    if (!isCurrent()) return;
    finish(
      el('p', { class: 'saved-label' }, 'Запланировано на'),
      el('p', { class: 'saved-date', 'data-testid': 'saved-planned' }, formatDate(row.date)),
      el('p', { class: 'saved-hint' }, 'Остаток не изменился. За 7 дней расход появится в «К оплате»'),
      el('dl', { class: 'saved-facts' }, el('dt', {}, 'Сумма'), el('dd', {}, formatMoney(row.amount, account().currency))),
    );
  }

  function showDebt(row) {
    if (!isCurrent()) return;
    const current = account();
    finish(
      el('p', { class: 'saved-label' }, 'Долг записан'),
      el('p', { class: 'saved-date', 'data-testid': 'saved-debt' }, formatMoney(row.amount, current.currency)),
      el('p', { class: 'saved-hint' }, 'Деньги не списаны. Затрата уже на объекте, долг виден на главной'),
      el('dl', { class: 'saved-facts' },
        el('dt', {}, 'За что'), el('dd', {}, categoryName()),
        el('dt', {}, 'Кому передать'), el('dd', {}, isPerson(current) ? personName(current) : 'Напрямую'),
        el('dt', {}, 'Отдать до'), el('dd', {}, row.due_date ? formatDate(row.due_date) : 'Срок не указан')),
    );
  }

  function savedActions() {
    return el('div', { class: 'saved-actions' },
      el('a', { class: 'button button-primary', href: editingId ? `#/tx?id=${editingId}` : '#/', 'data-back': true }, 'Готово'),
      el('button', {
        class: 'button',
        type: 'button',
        onClick: () => {
          replaceParams('/expense/new', new URLSearchParams());
          renderExpense({ view, isCurrent });
        },
      }, 'Ещё расход'));
  }

  async function cancelPlan() {
    const cancelled = await confirmSheet({
      title: 'Отменить?', message: 'Запись исчезнет из списка. Деньги не списывались.', confirmLabel: 'Отменить запись', cancelLabel: 'Оставить', danger: true,
    });
    if (!cancelled) return;
    await cancelPlannedExpense(payingId);
    toast('Отменено');
    goBack('/');
  }

  function isDirty() {
    return Boolean(amountInput.value || state.object_id || state.doc_type || state.photos.length || categoryName() || counterpartyName());
  }

  // Leaving a new expense with input asks first: by ✕, the back button or a swipe.
  setLeaveGuard(() => !payingId && !editingId && isDirty());

  // Built before any await so that focus() stays inside the user's tap.
  view.replaceChildren(
    el('header', { class: 'form-head' },
      backButton(editingId ? `#/tx?id=${editingId}` : '#/', { modal: true }),
      title,
      el('label', { class: 'date-button' }, dateLabel, dateInput)),
    el('div', { class: 'amount-box' }, amountInput, currencyLabel),
    amountError,
    planNote,
    form,
    el('div', { class: 'save-bar' }, saveButton),
  );
  if (!payingId && !editingId) amountInput.focus();

  function fillFromOperation(tx) {
    amountInput.value = amountToTyping(tx.amount);
    Object.assign(state, {
      account_id: tx.account_id,
      object_id: tx.object_id,
      category_id: tx.category_id,
      counterparty_id: tx.counterparty_id,
      doc_type: tx.doc_type,
      date: tx.date,
    });
    dateInput.value = tx.date;
    docNumber.value = tx.doc_number;
    comment.value = tx.description;
  }

  function fillFromTemplate(template) {
    amountInput.value = amountToTyping(template.amount);
    Object.assign(state, {
      account_id: template.account_id,
      object_id: template.object_id,
      category_id: template.category_id,
      counterparty_id: template.counterparty_id,
    });
    comment.value = template.name;
    title.textContent = template.name;
  }

  function fillFromPlan() {
    amountInput.value = amountToTyping(plan.amount);
    Object.assign(state, {
      account_id: plan.account_id,
      object_id: plan.object_id,
      category_id: plan.category_id,
      counterparty_id: plan.counterparty_id,
      doc_type: plan.doc_type,
    });
    if (plan.plan_kind === 'debt' && isPerson(account())) {
      state.source_account_id = refs.accounts.find((row) => !isPerson(row) && row.currency === account().currency)?.id ?? null;
    }
    docNumber.value = plan.doc_number;
    comment.value = plan.description;
    state.due_date = plan.due_date;
    state.plan_date = plan.date;
    dueInput.value = plan.due_date ?? '';
    title.textContent = plan.plan_kind === 'debt' ? 'Оплата долга' : 'Оплата';
  }

  function counterpartyItems(counterparties) {
    const active = counterparties.filter((row) => !row.is_archived);
    return COUNTERPARTY_GROUPS.flatMap(({ type, label }) => active
      .filter((row) => row.type === type)
      .map((row) => ({ id: row.id, label: row.name, sub: row.note, group: label }))
      .sort(byLabel));
  }

  async function loadForm() {
    const existingId = payingId ?? editingId;
    const [accounts, objects, categories, counterparties, balances, recent, settings, existing, storedPhotos, instance] = await Promise.all([
      db.accounts.toArray(), db.objects.toArray(), db.categories.toArray(), db.counterparties.toArray(),
      allBalances(), recentExpenseChoices(), getSettings(),
      existingId ? db.transactions.get(existingId) : null,
      existingId ? db.attachments.where('transaction_id').equals(existingId).count() : 0,
      instanceId ? db.recurring_instances.get(instanceId) : null,
    ]);
    const template = instance ? await db.recurring_templates.get(instance.template_id) : null;
    if (!isCurrent()) return;
    const groups = new Map(categories.map((row) => [row.id, row.name]));
    refs.accounts = sortAccounts(accounts.filter((row) => isMoneyAccount(row) && !row.is_archived));
    refs.balances = balances;
    refs.recent = recent;
    refs.lastRate = settings.last_usd_rate;
    refs.objectItems = objects.filter((row) => row.status === 'active').map((row) => ({ id: row.id, label: row.name })).sort(byLabel);
    refs.categoryItems = categories
      .filter((row) => row.kind === 'expense' && row.parent_id && !row.is_archived && row.code !== 'loan_repayment')
      .sort((a, b) => a.position - b.position)
      .map((row) => ({ id: row.id, label: shortName(row.name), sub: row.name !== shortName(row.name) ? row.name : null, group: groups.get(row.parent_id) }));
    refs.counterpartyItems = counterpartyItems(counterparties);

    const usable = refs.accounts.some((row) => row.id === recent.account_id);
    state.account_id = usable ? recent.account_id : refs.accounts[0]?.id ?? null;
    if (editingId && existing) {
      fillFromOperation(existing);
      state.stored_photos = storedPhotos;
      if (existing.rate && account()?.currency === 'USD') refs.lastRate = existing.rate;
    } else if (template) {
      fillFromTemplate(template);
    } else if (existing?.status === 'planned') {
      plan = existing;
      fillFromPlan();
      state.stored_photos = storedPhotos;
    } else if (payingId) {
      payingId = null;
      title.textContent = 'Расход';
      toast('Эта запись уже оплачена или отменена');
    }
    if (account()?.currency === 'USD') {
      state.rate = refs.lastRate;
      rateInput.value = state.rate ? formatRate(state.rate) : '';
    }
    renderForm();
  }

  loadForm();
  return () => {
    for (const photo of state.photos) URL.revokeObjectURL(photo.url);
  };
}
