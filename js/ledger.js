// The only place operations are written and balances are calculated.
// Balances are never stored: they are always derived from posted transactions.
import { db, getSettings, insertRow, updateRow } from './db.js';
import {
  RATE_ONE, amountInWords, computeAmountKgs, formatMoney, formatRate, monthOf, rateFromAmounts, toKgs, todayIso,
} from './money.js';

export const DOC_TYPES = [
  { code: 'fiscal_receipt', label: 'Чек ИКМ', short: 'Чек ИКМ' },
  { code: 'waybill', label: 'Накладная', short: 'Накладная' },
  { code: 'esf', label: 'ЭСФ', short: 'ЭСФ' },
  { code: 'act', label: 'Акт работ', short: 'Акт' },
  { code: 'invoice', label: 'Счёт на оплату', short: 'Счёт' },
  { code: 'payment_order', label: 'Платёжное поручение', short: 'Платёжка' },
  { code: 'cash_order', label: 'Расходный кассовый ордер', short: 'РКО' },
  { code: 'transfer_screenshot', label: 'Скриншот перевода', short: 'Скриншот' },
  { code: 'none', label: 'Без документа', short: 'Без документа' },
];

export const MAX_PHOTOS = 3;

// Where incoming money came from. Founder's money and loans are debts of the company.
export const INCOME_SOURCES = [
  { code: 'company', label: 'Из кассы', person: null },
  { code: 'founder', label: 'Учредитель', person: 'Кто дал', type: 'founder' },
  { code: 'loan', label: 'В долг', person: 'Кто дал', type: 'lender' },
  { code: 'customer', label: 'Заказчик', person: 'От кого', type: 'customer' },
];

const OWED_SOURCES = ['founder', 'loan'];

export function isOwedSource(code) {
  return OWED_SOURCES.includes(code);
}

export const COUNTERPARTY_GROUPS = [
  { type: 'founder', label: 'Учредители' },
  { type: 'lender', label: 'Кредиторы' },
  { type: 'supplier', label: 'Поставщики товаров' },
  { type: 'contractor', label: 'Подрядчики' },
  { type: 'service', label: 'Услуги' },
  { type: 'employee', label: 'Сотрудники' },
  { type: 'customer', label: 'Заказчики' },
  { type: 'buyer', label: 'Покупатели квартир' },
  { type: 'other', label: 'Прочие' },
];

const NEW_CATEGORIES_GROUP = 'new_items';
const ACCOUNT_TYPE_ORDER = ['cash', 'bank', 'card', 'ewallet', 'imprest', 'barter'];
const LARGE_AMOUNT = { KGS: 50000000, USD: 500000 }; // 500 000 som, 5 000 USD
const RATE_JUMP_PERCENT = 5;

const TX_TABLES = [
  'transactions', 'attachments', 'accounts', 'categories', 'objects', 'counterparties', 'settings',
  'audit_log', 'recurring_instances', 'barter_assets', 'periods',
];

export function ledgerTransaction(extraTables, scope) {
  return db.transaction('rw', [...new Set([...TX_TABLES, ...extraTables])], scope);
}

export class LedgerError extends Error {
  // kind 'invalid': issues must be fixed. kind 'needs_confirmation': issues are
  // warnings that the caller shows and passes back in `confirmed`.
  constructor(kind, issues) {
    super(issues.map((issue) => issue.message).join('; '));
    this.name = 'LedgerError';
    this.kind = kind;
    this.issues = issues;
  }
}

// Category names carry examples in brackets; chips and rows show the short form.
export function shortName(name) {
  return name.replace(/\s*\(.*\)$/, '');
}

// Comparison form of a typed name: "  КРЕПЁЖ " and "крепеж" are the same word.
export function normalizeName(text) {
  return text.trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
}

function tidyName(text) {
  const name = text.trim().replace(/\s+/g, ' ');
  return name[0].toUpperCase() + name.slice(1);
}

// Barter accounts hold valuations, not money (SPEC §8).
export function isMoneyAccount(account) {
  return account.type !== 'barter';
}

export function isCashTotalAccount(account) {
  return isMoneyAccount(account) && account.type !== 'imprest';
}

// Ids are random, so display order has to be explicit: cash first, soms before dollars.
export function sortAccounts(accounts) {
  const rank = (account) => ACCOUNT_TYPE_ORDER.indexOf(account.type);
  return [...accounts].sort((a, b) => rank(a) - rank(b)
    || a.currency.localeCompare(b.currency)
    || a.name.localeCompare(b.name, 'ru'));
}

function applyToBalance(balance, accountId, tx) {
  if (tx.status !== 'posted') return balance;
  if (tx.type === 'income' && tx.account_id === accountId) return balance + tx.amount;
  if (tx.type === 'expense' && tx.account_id === accountId) return balance - tx.amount;
  if (tx.type === 'transfer') {
    let next = balance;
    if (tx.account_id === accountId) next -= tx.amount;
    if (tx.to_account_id === accountId) next += tx.to_amount;
    return next;
  }
  return balance;
}

export function balanceFromTransactions(account, transactions) {
  return transactions.reduce((balance, tx) => applyToBalance(balance, account.id, tx), account.opening_balance);
}

export async function accountBalance(accountId) {
  const account = await db.accounts.get(accountId);
  const own = await db.transactions.where('account_id').equals(accountId).toArray();
  const incoming = await db.transactions.where('to_account_id').equals(accountId).toArray();
  const others = incoming.filter((tx) => tx.account_id !== accountId);
  return balanceFromTransactions(account, [...own, ...others]);
}

// All balances in one pass over posted operations: Map(accountId -> balance).
export async function allBalances() {
  const accounts = await db.accounts.toArray();
  const balances = new Map(accounts.map((account) => [account.id, account.opening_balance]));
  await db.transactions.where('status').equals('posted').each((tx) => {
    if (tx.type === 'transfer') {
      balances.set(tx.account_id, balances.get(tx.account_id) - tx.amount);
      balances.set(tx.to_account_id, balances.get(tx.to_account_id) + tx.to_amount);
    } else {
      const delta = tx.type === 'income' ? tx.amount : -tx.amount;
      balances.set(tx.account_id, balances.get(tx.account_id) + delta);
    }
  });
  return balances;
}

function effectOn(tx, accountId) {
  return tx ? applyToBalance(0, accountId, { ...tx, status: 'posted' }) : 0;
}

// `replaced` is the operation being edited: its old effect does not count.
async function checkOutflow(account, outflow, errors, warnings, replaced = null) {
  if (account.type === 'barter') return;
  const balance = (await accountBalance(account.id)) - effectOn(replaced, account.id);
  if (balance - outflow >= 0) return;
  const available = formatMoney(balance, account.currency);
  if (account.type === 'cash') {
    errors.push({
      field: 'amount',
      code: 'cash_negative',
      message: `На счёте «${account.name}» только ${available}. Вероятно, не внесено поступление.`,
    });
  } else {
    warnings.push({
      code: 'negative_balance',
      title: 'Счёт уйдёт в минус',
      message: `На счёте «${account.name}» ${available}, после операции остаток станет ${formatMoney(balance - outflow, account.currency)}.`,
    });
  }
}

export async function isMonthClosed(date) {
  const period = await db.periods.where('month').equals(monthOf(date)).first();
  return period?.status === 'closed';
}

const MONTH_CLOSED = {
  code: 'month_closed',
  field: 'date',
  message: 'Этот месяц закрыт. Изменить его нельзя, исправление делается обратной операцией.',
};

function checkRateJump(rate, settings, warnings) {
  const previous = settings?.last_usd_rate;
  if (!previous || !rate) return;
  if (Math.abs(rate - previous) * 100 > previous * RATE_JUMP_PERCENT) {
    warnings.push({
      code: 'rate_jump',
      title: 'Курс сильно отличается',
      message: `Курс ${formatRate(rate)} отличается от предыдущего ${formatRate(previous)} больше чем на ${RATE_JUMP_PERCENT}%.`,
    });
  }
}

function resolveRate(draft, account, toAccount) {
  if (toAccount && toAccount.currency !== account.currency) {
    if (!draft.amount || !draft.to_amount) return null;
    return account.currency === 'KGS'
      ? rateFromAmounts(draft.amount, draft.to_amount)
      : rateFromAmounts(draft.to_amount, draft.amount);
  }
  return account.currency === 'KGS' ? RATE_ONE : draft.rate;
}

// Returns { errors, warnings }. errors carry `field` for the form, warnings
// carry `code` and require explicit confirmation.
export async function checkTransaction(draft) {
  const errors = [];
  const warnings = [];
  const missing = (field, message) => errors.push({ field, code: 'required', message });
  const planned = draft.status === 'planned';
  const debt = draft.plan_kind === 'debt';

  const amountOk = Number.isSafeInteger(draft.amount) && draft.amount > 0;
  if (!amountOk) missing('amount', 'Укажите сумму');

  const account = draft.account_id ? await db.accounts.get(draft.account_id) : null;
  if (!account) missing('account_id', draft.type === 'transfer' ? 'Укажите, с какого счёта' : 'Укажите счёт');

  if (!draft.date) {
    missing('date', 'Укажите дату');
  } else if (!debt && planned !== (draft.date > todayIso())) {
    errors.push({
      field: 'date',
      code: planned ? 'plan_needs_future_date' : 'future_date',
      message: planned ? 'Запланировать можно только на будущую дату' : 'Дата не может быть в будущем',
    });
  }

  let toAccount = null;
  if (draft.date && !planned && await isMonthClosed(draft.date)) errors.push(MONTH_CLOSED);
  if (draft.date && debt && await isMonthClosed(draft.date)) errors.push(MONTH_CLOSED);
  if (draft.replacing && await isMonthClosed(draft.replacing.date)) errors.push(MONTH_CLOSED);

  if (debt && draft.due_date && draft.date && draft.due_date < draft.date) {
    errors.push({ field: 'due_date', code: 'due_before_date', message: 'Срок не может быть раньше даты покупки' });
  }

  if (draft.type === 'transfer') {
    toAccount = draft.to_account_id ? await db.accounts.get(draft.to_account_id) : null;
    if (!toAccount) missing('to_account_id', 'Укажите, на какой счёт');
    if (toAccount && toAccount.id === draft.account_id) {
      errors.push({ field: 'to_account_id', code: 'same_account', message: 'Счета должны быть разными' });
    }
    if (account && toAccount && account.currency !== toAccount.currency) {
      const toAmountOk = Number.isSafeInteger(draft.to_amount) && draft.to_amount > 0;
      if (!toAmountOk) missing('to_amount', 'Укажите, сколько зачислено');
    }
  }

  if (draft.type === 'expense') {
    const category = draft.category_id ? await db.categories.get(draft.category_id) : null;
    if (!draft.object_id && draft.source_kind !== 'repayment') missing('object_id', 'Выберите объект');
    if (category?.kind !== 'expense' && !draft.category_name?.trim()) missing('category_id', 'Укажите статью');
    if (!planned && !DOC_TYPES.some((doc) => doc.code === draft.doc_type)) missing('doc_type', 'Выберите тип документа');
  }

  if (draft.type === 'income') {
    const category = draft.category_id ? await db.categories.get(draft.category_id) : null;
    if (category?.kind !== 'income' && !draft.category_name?.trim()) missing('category_id', 'Укажите статью поступления');
    if (category?.code === 'customer_payment' && !draft.object_id) {
      missing('object_id', 'Для оплаты заказчика укажите объект');
    }
    if (isOwedSource(draft.source_kind) && !draft.counterparty_id && !draft.counterparty_name?.trim()) {
      missing('counterparty_id', 'Укажите, кто дал деньги');
    }
  }

  if (account) {
    const rate = resolveRate(draft, account, toAccount);
    const usedUsd = account.currency === 'USD' || toAccount?.currency === 'USD';
    if (usedUsd && !(rate > 0) && amountOk) missing('rate', 'Укажите курс к сому');
    if (usedUsd) checkRateJump(rate, await getSettings(), warnings);

    if (amountOk) {
      const replaced = draft.replacing ?? null;
      if (draft.type !== 'income' && !planned) {
        await checkOutflow(account, draft.amount + (draft.fee ?? 0), errors, warnings, replaced);
      }
      if (replaced) {
        if (draft.type === 'income') await checkOutflow(account, -draft.amount, errors, warnings, replaced);
        if (draft.type === 'transfer' && toAccount) {
          await checkOutflow(toAccount, -(draft.to_amount ?? draft.amount), errors, warnings, replaced);
        }
        if (replaced.account_id !== account.id) {
          await checkOutflow(await db.accounts.get(replaced.account_id), 0, errors, warnings, replaced);
        }
      }
      if (draft.amount > LARGE_AMOUNT[account.currency]) {
        warnings.push({
          code: 'large_amount',
          title: 'Проверьте сумму',
          amount: formatMoney(draft.amount, account.currency),
          message: amountInWords(draft.amount, account.currency),
        });
      }
    }
  }

  return { errors, warnings };
}

async function assertAllowed(draft, confirmed) {
  const { errors, warnings } = await checkTransaction(draft);
  if (errors.length > 0) throw new LedgerError('invalid', errors);
  const unconfirmed = warnings.filter((warning) => !confirmed.includes(warning.code));
  if (unconfirmed.length > 0) throw new LedgerError('needs_confirmation', unconfirmed);
}

async function nextNumber() {
  const last = await db.transactions.orderBy('number').last();
  return (last?.number ?? 0) + 1;
}

async function rememberUsdRate(rate) {
  const settings = await getSettings();
  if (settings.last_usd_rate !== rate) await updateRow('settings', settings.id, { last_usd_rate: rate });
}

function transactionFields(draft, account, toAccount) {
  const toAmount = draft.type === 'transfer' ? (draft.to_amount ?? draft.amount) : null;
  const rate = resolveRate(draft, account, toAccount);
  return {
    type: draft.type,
    plan_kind: draft.plan_kind ?? null,
    source_kind: draft.source_kind ?? null,
    due_date: draft.due_date ?? null,
    cost_date: draft.cost_date ?? null,
    date: draft.date,
    account_id: draft.account_id,
    amount: draft.amount,
    to_account_id: draft.to_account_id ?? null,
    to_amount: toAmount,
    rate,
    amount_kgs: computeAmountKgs({
      currency: account.currency,
      amount: draft.amount,
      rate,
      toCurrency: toAccount?.currency ?? null,
      toAmount,
    }),
    object_id: draft.object_id ?? null,
    category_id: draft.category_id ?? null,
    counterparty_id: draft.counterparty_id ?? null,
    description: draft.description ?? '',
    doc_type: draft.doc_type ?? null,
    doc_number: draft.doc_number ?? '',
    reversal_of_id: draft.reversal_of_id ?? null,
    reversal_reason: null,
    reversed_at: null,
    recurring_instance_id: draft.recurring_instance_id ?? null,
    barter_asset_id: draft.barter_asset_id ?? null,
    barter_meta: draft.barter_meta ?? null,
    barter_kind: draft.barter_kind ?? null,
    parent_transaction_id: draft.parent_transaction_id ?? null,
  };
}

async function insertTransaction(draft, account, toAccount) {
  const fields = transactionFields(draft, account, toAccount);
  if (draft.status === 'planned') return insertRow('transactions', { ...fields, number: null, status: 'planned' });
  const row = await insertRow('transactions', { ...fields, number: await nextNumber(), status: 'posted' });
  if (account.currency === 'USD' || toAccount?.currency === 'USD') await rememberUsdRate(row.rate);
  return row;
}

async function findOrCreateCategory(name, kind = 'expense') {
  const categories = await db.categories.where('kind').equals(kind).toArray();
  const key = normalizeName(name);
  const found = categories.find((row) => row.parent_id
    && (normalizeName(row.name) === key || normalizeName(shortName(row.name)) === key));
  if (found) return found;
  let position = Math.max(...categories.map((row) => row.position));
  let group = categories.find((row) => row.code === NEW_CATEGORIES_GROUP);
  if (!group) {
    position += 1;
    group = await insertRow('categories', {
      name: 'Новые статьи', kind, parent_id: null, code: NEW_CATEGORIES_GROUP, position,
    });
  }
  return insertRow('categories', {
    name: tidyName(name), kind, parent_id: group.id, code: null, position: position + 1,
  });
}

async function findOrCreateCounterparty(name, type) {
  const counterparties = await db.counterparties.toArray();
  const key = normalizeName(name);
  return counterparties.find((row) => normalizeName(row.name) === key)
    ?? createCounterparty({ name: tidyName(name), type: type ?? 'other' });
}

// Names typed in the form are remembered here, inside the transaction that saves
// the expense: a save that fails leaves nothing behind.
async function resolveNames({ category_name: categoryName, counterparty_name: counterpartyName, counterparty_type: counterpartyType, ...draft }) {
  if (!draft.category_id && categoryName?.trim()) {
    draft.category_id = (await findOrCreateCategory(categoryName, draft.type === 'expense' ? 'expense' : 'income')).id;
  }
  if (!draft.counterparty_id && counterpartyName?.trim()) {
    draft.counterparty_id = (await findOrCreateCounterparty(counterpartyName, counterpartyType)).id;
  }
  return draft;
}

async function post(draft, confirmed) {
  const resolved = await resolveNames(draft);
  await assertAllowed(resolved, confirmed);
  const account = await db.accounts.get(resolved.account_id);
  const toAccount = resolved.to_account_id ? await db.accounts.get(resolved.to_account_id) : null;
  return insertTransaction(resolved, account, toAccount);
}

async function savePhotos(transactionId, photos) {
  const stored = await db.attachments.where('transaction_id').equals(transactionId).count();
  for (const blob of photos.slice(0, MAX_PHOTOS - stored)) {
    await insertRow('attachments', { transaction_id: transactionId, barter_asset_id: null, blob, size: blob.size });
  }
}

export async function createExpense(draft, { confirmed = [], photos = [] } = {}) {
  return ledgerTransaction([], async () => {
    const row = await post({ ...draft, type: 'expense' }, confirmed);
    await savePhotos(row.id, photos);
    if (row.recurring_instance_id) {
      await updateRow('recurring_instances', row.recurring_instance_id, { status: 'paid', transaction_id: row.id });
    }
    return row;
  });
}

// A planned expense only reminds: no number and no effect on balances until paid.
export async function createPlannedExpense(draft, { confirmed = [], photos = [] } = {}) {
  return ledgerTransaction([], async () => {
    const row = await post({ ...draft, type: 'expense', status: 'planned', plan_kind: 'plan' }, confirmed);
    await savePhotos(row.id, photos);
    return row;
  });
}

// Goods or services taken and not paid for yet. Like a plan it moves no money;
// account_id is the person the money has to go through, if there is one.
export async function createDebt(draft, { confirmed = [], photos = [] } = {}) {
  return ledgerTransaction([], async () => {
    const row = await post({ ...draft, type: 'expense', status: 'planned', plan_kind: 'debt' }, confirmed);
    await savePhotos(row.id, photos);
    return row;
  });
}

export async function openDebts() {
  const planned = await db.transactions.where('status').equals('planned').toArray();
  // Nearest deadline first, debts without one last.
  const deadline = (tx) => tx.due_date ?? '9999-12-31';
  return planned.filter((tx) => tx.plan_kind === 'debt')
    .sort((a, b) => deadline(a).localeCompare(deadline(b)) || a.date.localeCompare(b.date));
}

async function plannedRow(id) {
  const row = await db.transactions.get(id);
  if (row?.status !== 'planned') {
    throw new LedgerError('invalid', [{ code: 'not_planned', message: 'Этот расход уже оплачен или отменён' }]);
  }
  return row;
}

// Payment is the real expense: all checks apply and the number is assigned now.
// With sourceAccountId the money first goes to the person (a transfer), then the
// expense is written from that person's account, so both steps stay on record.
export async function payPlannedExpense(id, draft, { confirmed = [], photos = [], sourceAccountId = null } = {}) {
  return ledgerTransaction([], async () => {
    const planned = await plannedRow(id);
    const resolved = await resolveNames({ ...draft, type: 'expense', status: undefined });
    const handedOver = Boolean(sourceAccountId) && sourceAccountId !== resolved.account_id;
    if (handedOver) {
      await createTransfer({
        date: resolved.date,
        account_id: sourceAccountId,
        to_account_id: resolved.account_id,
        amount: resolved.amount,
        description: resolved.description ? `Передано на оплату: ${resolved.description}` : 'Передано на оплату долга',
      }, { confirmed });
    }
    await assertAllowed(resolved, handedOver ? [...confirmed, 'negative_balance', 'large_amount'] : confirmed);
    const account = await db.accounts.get(resolved.account_id);
    const row = await updateRow('transactions', id, {
      ...transactionFields(resolved, account, null),
      plan_kind: planned.plan_kind,
      due_date: planned.due_date,
      // A debt is a cost of the object from the day of purchase, `date` is now the
      // day the money left.
      cost_date: planned.plan_kind === 'debt' ? planned.date : null,
      number: await nextNumber(),
      status: 'posted',
    }, 'pay');
    if (account.currency === 'USD') await rememberUsdRate(row.rate);
    await savePhotos(id, photos);
    return row;
  });
}

export async function cancelPlannedExpense(id) {
  return ledgerTransaction([], async () => {
    await plannedRow(id);
    return updateRow('transactions', id, { status: 'cancelled' }, 'cancel');
  });
}

export async function createIncome(draft, { confirmed = [], photos = [] } = {}) {
  return ledgerTransaction([], async () => {
    const row = await post({ ...draft, type: 'income' }, confirmed);
    await savePhotos(row.id, photos);
    return row;
  });
}

// A transfer between currencies is an exchange: amount and to_amount are both
// set, rate is derived from them. `fee` becomes a separate expense (SPEC §5.5).
export async function createTransfer(draft, { confirmed = [] } = {}) {
  return ledgerTransaction([], async () => {
    const { fee = 0, ...rest } = draft;
    const row = await post({ ...rest, fee, type: 'transfer' }, confirmed);
    if (fee > 0) {
      const objects = await db.objects.toArray();
      const feeCategory = await db.categories.where('code').equals('bank_fee').first();
      await insertTransaction({
        type: 'expense',
        date: draft.date,
        account_id: draft.account_id,
        amount: fee,
        // An exchange has no typed rate: the fee in dollars takes the rate of the exchange.
        rate: row.rate,
        object_id: objects.find((object) => object.is_overhead).id,
        category_id: feeCategory.id,
        description: `Комиссия за перевод №${row.number}`,
        doc_type: 'payment_order',
        parent_transaction_id: row.id,
      }, await db.accounts.get(draft.account_id), null);
    }
    return row;
  });
}

function definedFields(draft) {
  return Object.fromEntries(Object.entries(draft).filter(([, value]) => value !== undefined));
}

// Editing a posted operation: same checks as saving, old and new values go to
// audit_log. amount_kgs changes only because the operation itself changed.
export async function updateTransaction(id, draft, { confirmed = [], photos = [] } = {}) {
  return ledgerTransaction([], async () => {
    const old = await db.transactions.get(id);
    if (old?.status !== 'posted') {
      throw new LedgerError('invalid', [{ code: 'not_posted', message: 'Эту операцию нельзя изменить' }]);
    }
    const resolved = await resolveNames({ ...old, ...definedFields(draft), status: undefined, type: old.type });
    await assertAllowed({ ...resolved, replacing: old }, confirmed);
    const account = await db.accounts.get(resolved.account_id);
    const toAccount = resolved.to_account_id ? await db.accounts.get(resolved.to_account_id) : null;
    const row = await updateRow('transactions', id, transactionFields(resolved, account, toAccount));
    await savePhotos(id, photos);
    return row;
  });
}

// Changing a plan or a debt before it is paid: no money moves yet.
export async function updatePlannedExpense(id, draft, { confirmed = [], photos = [] } = {}) {
  return ledgerTransaction([], async () => {
    const planned = await plannedRow(id);
    const resolved = await resolveNames({ ...planned, ...definedFields(draft), type: 'expense', status: 'planned' });
    await assertAllowed(resolved, confirmed);
    const account = await db.accounts.get(resolved.account_id);
    const row = await updateRow('transactions', id, transactionFields(resolved, account, null));
    await savePhotos(id, photos);
    return row;
  });
}

// Cancelling money that came in can leave a cash account negative, so the same
// rule applies here as on saving.
async function checkReversal(tx) {
  const inflow = tx.type === 'income'
    ? { accountId: tx.account_id, amount: tx.amount }
    : tx.type === 'transfer' ? { accountId: tx.to_account_id, amount: tx.to_amount } : null;
  if (!inflow) return;
  const account = await db.accounts.get(inflow.accountId);
  const errors = [];
  await checkOutflow(account, inflow.amount, errors, []);
  if (errors.length > 0) throw new LedgerError('invalid', errors);
}

export async function reverseTransaction(id, reason) {
  return ledgerTransaction([], async () => {
    const tx = await db.transactions.get(id);
    if (!reason?.trim()) {
      throw new LedgerError('invalid', [{ field: 'reason', code: 'required', message: 'Укажите причину сторно' }]);
    }
    if (tx.status !== 'posted') {
      throw new LedgerError('invalid', [{ code: 'already_reversed', message: 'Операция уже сторнирована' }]);
    }
    if (await isMonthClosed(tx.date)) throw new LedgerError('invalid', [MONTH_CLOSED]);
    await checkReversal(tx);
    const row = await updateRow('transactions', id, {
      status: 'reversed', reversal_reason: reason.trim(), reversed_at: new Date().toISOString(),
    }, 'reverse');
    if (tx.recurring_instance_id) {
      await updateRow('recurring_instances', tx.recurring_instance_id, { status: 'pending', transaction_id: null });
    }
    // The goods are still taken: reversing the payment of a debt brings the debt back.
    if (tx.plan_kind === 'debt') {
      const account = await db.accounts.get(tx.account_id);
      const fields = transactionFields({ ...tx, date: tx.cost_date ?? tx.date, cost_date: null }, account, null);
      await insertRow('transactions', { ...fields, number: null, status: 'planned' });
    }
    return row;
  });
}

// Closed month: the original stays as it is and the correction goes into the open
// month, so the closed report does not change (SPEC §6).
export async function reverseWithOpposite(id, reason, date = todayIso()) {
  return ledgerTransaction([], async () => {
    const tx = await db.transactions.get(id);
    if (!reason?.trim()) {
      throw new LedgerError('invalid', [{ field: 'reason', code: 'required', message: 'Укажите причину' }]);
    }
    if (tx.status !== 'posted' || tx.reversed_by_id || tx.reversal_of_id) {
      throw new LedgerError('invalid', [{ code: 'already_reversed', message: 'Эта операция уже исправлена' }]);
    }
    if (await isMonthClosed(date)) throw new LedgerError('invalid', [MONTH_CLOSED]);
    await checkReversal(tx);
    const transfer = tx.type === 'transfer';
    const draft = {
      ...tx,
      type: transfer ? 'transfer' : tx.type === 'expense' ? 'income' : 'expense',
      date,
      account_id: transfer ? tx.to_account_id : tx.account_id,
      to_account_id: transfer ? tx.account_id : null,
      amount: transfer ? tx.to_amount : tx.amount,
      to_amount: transfer ? tx.amount : null,
      description: `Обратная к №${tx.number}: ${reason.trim()}`,
      reversal_of_id: tx.id,
      recurring_instance_id: null,
      plan_kind: null,
      due_date: null,
      cost_date: null,
    };
    const account = await db.accounts.get(draft.account_id);
    const toAccount = transfer ? await db.accounts.get(draft.to_account_id) : null;
    const row = await insertRow('transactions', {
      ...transactionFields(draft, account, toAccount),
      reversal_kind: tx.type,
      number: await nextNumber(),
      status: 'posted',
    });
    await updateRow('transactions', id, { reversed_by_id: row.id }, 'reverse_link');
    return row;
  });
}

// Fixes an actual balance found at month closing, on the article that the reports
// always show on its own line (SPEC §6).
export async function createCorrection(accountId, delta, date) {
  return ledgerTransaction([], async () => {
    const category = await db.categories.where('code').equals('cash_discrepancy').first();
    const objects = await db.objects.toArray();
    const account = await db.accounts.get(accountId);
    const settings = await getSettings();
    const draft = {
      type: delta < 0 ? 'expense' : 'income',
      date,
      account_id: accountId,
      amount: Math.abs(delta),
      rate: account.currency === 'USD' ? settings.last_usd_rate : undefined,
      object_id: objects.find((object) => object.is_overhead).id,
      category_id: category.id,
      doc_type: 'none',
      description: 'Корректировка при закрытии месяца',
    };
    return insertRow('transactions', {
      ...transactionFields(draft, account, null),
      reversal_kind: delta > 0 ? 'expense' : null,
      number: await nextNumber(),
      status: 'posted',
    });
  });
}

// A person money goes through is an imprest account (SPEC §11).
export function personName(account) {
  return account.name.replace(/^Подотчёт:\s*/, '');
}

// What the company owes to founders and lenders, per person. A debt is kept in the
// currency the money came in: $1 000 lent is $1 000 to return, whatever the rate.
// `by_currency` holds minor units per currency, `owed` is the total in soms with
// dollars at the last rate, like the home total.
export async function lenderBalances() {
  const [posted, accounts, settings] = await Promise.all([
    db.transactions.where('status').equals('posted').toArray(), db.accounts.toArray(), getSettings(),
  ]);
  const currencies = new Map(accounts.map((row) => [row.id, row.currency]));
  const lenders = new Map();
  for (const tx of posted) {
    const received = isOwedSource(tx.source_kind);
    if (!received && tx.source_kind !== 'repayment') continue;
    const entry = lenders.get(tx.counterparty_id) ?? {
      counterparty_id: tx.counterparty_id, by_currency: { KGS: 0, USD: 0 }, owed: 0, source_kind: tx.source_kind, due_date: null,
    };
    const currency = currencies.get(tx.account_id);
    entry.by_currency[currency] += (received ? 1 : -1) * (tx.reversal_kind ? -1 : 1) * tx.amount;
    if (received) {
      entry.source_kind = tx.source_kind;
      if (tx.due_date) entry.due_date = tx.due_date;
    }
    lenders.set(tx.counterparty_id, entry);
  }
  const rate = settings?.last_usd_rate ?? 0;
  return [...lenders.values()]
    .filter((entry) => entry.by_currency.KGS !== 0 || entry.by_currency.USD !== 0)
    .map((entry) => ({ ...entry, owed: entry.by_currency.KGS + toKgs(entry.by_currency.USD, rate) }));
}

// "$1 000" or "87 000 сом и $1 000": a debt in the currencies it was taken in.
export function owedText(entry) {
  const parts = ['KGS', 'USD'].filter((currency) => entry.by_currency[currency] !== 0)
    .map((currency) => formatMoney(entry.by_currency[currency], currency));
  return parts.length > 0 ? parts.join(' и ') : formatMoney(0, 'KGS');
}

// Returning money is not a cost of any object: it has no object and stays out of
// object reports, the cash flow shows it on its own line. It lowers the debt in the
// currency of the account it is paid from.
export async function createRepayment({ counterparty_id: counterpartyId, account_id: accountId, amount, rate, date, doc_type: docType }, { confirmed = [] } = {}) {
  return ledgerTransaction([], async () => {
    const category = await db.categories.where('code').equals('loan_repayment').first();
    const account = await db.accounts.get(accountId);
    const settings = await getSettings();
    const usedRate = account.currency === 'USD' ? rate ?? settings.last_usd_rate : undefined;
    const entry = (await lenderBalances()).find((row) => row.counterparty_id === counterpartyId);
    const owed = entry?.by_currency[account.currency] ?? 0;
    if (amount > owed) {
      const other = account.currency === 'USD' ? 'KGS' : 'USD';
      const message = owed <= 0 && entry?.by_currency[other] > 0
        ? `Долг в ${other === 'USD' ? 'долларах' : 'сомах'}: ${formatMoney(entry.by_currency[other], other)}. Верните со счёта в этой валюте.`
        : `Мы должны только ${formatMoney(owed, account.currency)}`;
      throw new LedgerError('invalid', [{ field: 'amount', code: 'over_owed', message }]);
    }
    return post({
      type: 'expense',
      source_kind: 'repayment',
      date,
      account_id: accountId,
      amount,
      rate: usedRate,
      object_id: null,
      category_id: category.id,
      counterparty_id: counterpartyId,
      doc_type: docType,
      description: 'Возврат денег',
    }, confirmed);
  });
}

export async function createPerson(name) {
  return db.transaction('rw', db.accounts, db.audit_log, async () => {
    const accounts = await db.accounts.where('type').equals('imprest').toArray();
    const key = normalizeName(name);
    return accounts.find((row) => normalizeName(personName(row)) === key) ?? insertRow('accounts', {
      name: `Подотчёт: ${tidyName(name)}`, type: 'imprest', currency: 'KGS', opening_balance: 0, opening_date: todayIso(), is_archived: false,
    });
  });
}

export async function createCounterparty({ name, type = 'other', phone = '', inn = '', note = '' }) {
  const trimmed = name?.trim();
  if (!trimmed) throw new LedgerError('invalid', [{ field: 'name', code: 'required', message: 'Укажите название' }]);
  return db.transaction('rw', db.counterparties, db.audit_log, () => insertRow('counterparties', {
    name: trimmed, type, phone, inn, note, is_archived: false,
  }));
}

// A name typed into a picker: the same name already on record is reused, whatever
// its type, so the directory gets no twins.
export async function ensureCounterparty(name, type = 'other') {
  const trimmed = name?.trim();
  if (!trimmed) throw new LedgerError('invalid', [{ field: 'name', code: 'required', message: 'Укажите название' }]);
  return db.transaction('rw', db.counterparties, db.audit_log, async () => {
    const key = normalizeName(trimmed);
    const found = (await db.counterparties.toArray()).find((row) => normalizeName(row.name) === key);
    return found ?? insertRow('counterparties', {
      name: tidyName(trimmed), type, phone: '', inn: '', note: '', is_archived: false,
    });
  });
}

const REF_TABLES = ['accounts', 'objects', 'categories', 'counterparties'];

// Directory records. They are archived, never deleted: operations refer to them.
export async function saveRef(table, id, fields) {
  if (!REF_TABLES.includes(table)) throw new Error(`Unknown directory ${table}`);
  if (!fields.name?.trim()) throw new LedgerError('invalid', [{ field: 'name', code: 'required', message: 'Укажите название' }]);
  return db.transaction('rw', db.table(table), db.transactions, db.audit_log, async () => {
    const values = { ...fields, name: fields.name.trim() };
    if (!id) return insertRow(table, { is_archived: false, ...values });
    if (table === 'accounts') {
      const old = await db.accounts.get(id);
      const used = await db.transactions.where('account_id').equals(id).count()
        + await db.transactions.where('to_account_id').equals(id).count();
      if (used > 0 && values.currency && values.currency !== old.currency) {
        throw new LedgerError('invalid', [{ field: 'currency', code: 'currency_locked', message: 'Валюту счёта с операциями менять нельзя' }]);
      }
    }
    return updateRow(table, id, values);
  });
}

export async function setRefArchived(table, id, archived) {
  return db.transaction('rw', db.table(table), db.audit_log, () => {
    const change = table === 'objects' ? { status: archived ? 'archived' : 'active' } : { is_archived: archived };
    return updateRow(table, id, change, archived ? 'archive' : 'restore');
  });
}

export async function reopenMonth(month, reason) {
  if (!reason?.trim()) throw new LedgerError('invalid', [{ field: 'reason', code: 'required', message: 'Укажите причину' }]);
  return db.transaction('rw', db.periods, db.audit_log, async () => {
    const period = await db.periods.where('month').equals(month).first();
    return updateRow('periods', period.id, { status: 'open', closed_at: null, reopen_reason: reason.trim() }, 'reopen');
  });
}

export async function closeMonth(month, closingBalances) {
  return db.transaction('rw', db.periods, db.audit_log, async () => {
    const period = await db.periods.where('month').equals(month).first();
    const fields = { status: 'closed', closed_at: new Date().toISOString(), closing_balances: closingBalances };
    return period ? updateRow('periods', period.id, fields, 'close') : insertRow('periods', { month, ...fields });
  });
}

export async function updateSettings(changes) {
  const settings = await getSettings();
  return db.transaction('rw', db.settings, db.audit_log, () => updateRow('settings', settings.id, changes));
}

// The rate entered by hand, without any USD operation.
export async function setLastUsdRate(rate) {
  await db.transaction('rw', db.settings, db.audit_log, () => rememberUsdRate(rate));
}

// Recently used references for pickers and form defaults, newest first.
export async function recentExpenseChoices(limit = 300) {
  const rows = await db.transactions.orderBy('number').reverse().limit(limit).toArray();
  // Automatic fees and barter steps are not choices the user made in the form.
  const expenses = rows.filter((tx) => tx.type === 'expense' && tx.status === 'posted'
    && !tx.parent_transaction_id && !tx.barter_asset_id && tx.source_kind !== 'repayment');
  const unique = (field) => [...new Set(expenses.map((tx) => tx[field]).filter(Boolean))];
  const combos = new Map();
  for (const { object_id: objectId, category_id: categoryId, counterparty_id: counterpartyId } of expenses) {
    const key = `${objectId}|${categoryId}|${counterpartyId}`;
    if (!combos.has(key)) combos.set(key, { object_id: objectId, category_id: categoryId, counterparty_id: counterpartyId });
  }
  return {
    // A paid debt or plan keeps its own account, which is not the user's last choice.
    account_id: expenses.find((tx) => !tx.plan_kind)?.account_id ?? null,
    object_ids: unique('object_id'),
    category_ids: unique('category_id'),
    counterparty_ids: unique('counterparty_id'),
    doc_types: unique('doc_type'),
    combos: [...combos.values()],
  };
}

// The object and category of the counterparty's latest expense (SPEC §5.3).
export async function counterpartyDefaults(counterpartyId) {
  const rows = await db.transactions.where('counterparty_id').equals(counterpartyId).toArray();
  const expenses = rows.filter((tx) => tx.type === 'expense' && tx.status === 'posted');
  const latest = expenses.reduce((best, tx) => (!best || tx.number > best.number ? tx : best), null);
  return latest ? { object_id: latest.object_id, category_id: latest.category_id } : null;
}

export async function latestTransactions(limit) {
  return db.transactions.orderBy('number').reverse().limit(limit).toArray();
}
