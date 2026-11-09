// Directories: accounts, people, objects, articles, counterparties. Records in use are
// archived, never deleted (SPEC §5.11). Articles are the exception: one can be
// deleted after its operations move to another article.
import { db } from '../db.js';
import {
  COUNTERPARTY_GROUPS, categoryUsage, deleteCategory, deleteCategoryGroup, isSystemCategory, personName, saveRef, setRefArchived,
  shortName, sortAccounts,
} from '../ledger.js';
import { formatMoney, pluralRu, todayIso } from '../money.js';
import { confirmSheet } from '../ui/confirm.js';
import { el } from '../ui/dom.js';
import { editSheet } from '../ui/edit-sheet.js';
import { firstIssue, formHead } from '../ui/form.js';
import { openPicker } from '../ui/picker.js';
import { toast } from '../ui/toast.js';

const TITLES = {
  accounts: 'Счета', people: 'Люди', objects: 'Объекты', categories: 'Статьи и группы', counterparties: 'Контрагенты',
};
const ACCOUNT_TYPES = [
  { value: 'cash', label: 'Наличные' }, { value: 'bank', label: 'Расчётный счёт' }, { value: 'card', label: 'Карта' },
  { value: 'ewallet', label: 'Кошелёк' },
];
const CURRENCIES = [{ value: 'KGS', label: 'KGS' }, { value: 'USD', label: 'USD' }];

function isArchived(table, row) {
  return table === 'objects' ? row.status === 'archived' : Boolean(row.is_archived);
}

const SHAPES = {
  accounts: {
    load: async () => sortAccounts((await db.accounts.toArray()).filter((row) => row.type !== 'barter' && row.type !== 'imprest')),
    sub: (row) => `${ACCOUNT_TYPES.find((type) => type.value === row.type)?.label}, ${row.currency}, начальный остаток ${formatMoney(row.opening_balance, row.currency)}`,
    fields: (row) => [
      { key: 'name', label: 'Название', type: 'text', value: row?.name },
      { key: 'type', label: 'Тип', type: 'select', value: row?.type ?? 'cash', options: ACCOUNT_TYPES },
      { key: 'currency', label: 'Валюта', type: 'select', value: row?.currency ?? 'KGS', options: CURRENCIES },
      { key: 'opening_balance', label: 'Начальный остаток', type: 'amount', value: row?.opening_balance ?? 0 },
      { key: 'opening_date', label: 'На дату', type: 'date', value: row?.opening_date ?? todayIso() },
    ],
  },
  // People hold money for purchases; each of them is an imprest account.
  people: {
    table: 'accounts',
    load: async () => sortAccounts((await db.accounts.where('type').equals('imprest').toArray())),
    title: (row) => personName(row),
    sub: (row) => (row.opening_balance ? `Начальный остаток ${formatMoney(row.opening_balance, row.currency)}` : ''),
    fields: (row) => [
      { key: 'name', label: 'Имя', type: 'text', value: row ? personName(row) : null },
      { key: 'opening_balance', label: 'Деньги на руках на старте', type: 'amount', value: row?.opening_balance ?? 0 },
    ],
    normalize: (values, row) => ({
      ...values, name: `Подотчёт: ${values.name.trim()}`, type: 'imprest', currency: 'KGS', opening_date: row?.opening_date ?? todayIso(),
    }),
  },
  objects: {
    load: async () => (await db.objects.toArray()).sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    sub: (row) => row.address,
    fields: (row, extra) => [
      { key: 'name', label: 'Название', type: 'text', value: row?.name },
      { key: 'address', label: 'Адрес', type: 'text', value: row?.address, optional: true },
      {
        key: 'customer_id',
        label: 'Заказчик',
        type: 'counterparty',
        counterpartyType: 'customer',
        createLabel: 'Новый заказчик',
        value: row?.customer_id,
        optional: true,
        options: extra.counterparties.filter((item) => item.type === 'customer').map((item) => ({ value: item.id, label: item.name })),
      },
      {
        key: 'status',
        label: 'Статус',
        type: 'select',
        value: row?.status === 'completed' ? 'completed' : 'active',
        options: [{ value: 'active', label: 'Идёт' }, { value: 'completed', label: 'Завершён' }],
      },
    ],
    normalize: (values, row) => ({ ...values, address: values.address ?? '', is_overhead: row?.is_overhead ?? false }),
  },
  categories: {
    load: async () => {
      const rows = await db.categories.toArray();
      return rows.filter((row) => row.parent_id).sort((a, b) => (a.kind === b.kind ? a.position - b.position : a.kind.localeCompare(b.kind)));
    },
    sub: (row, extra) => extra.groups.get(row.parent_id)?.name,
    fields: (row, extra) => [
      { key: 'name', label: 'Название', type: 'text', value: row?.name },
      {
        key: 'parent_id',
        label: 'Группа',
        type: 'select',
        value: row?.parent_id,
        options: [...extra.groups.values()].filter((group) => !row || group.kind === row.kind).map((group) => ({ value: group.id, label: group.name })),
      },
    ],
    normalize: (values, row, extra) => ({
      ...values, kind: extra.groups.get(values.parent_id).kind, code: row?.code ?? null, position: row?.position ?? Date.now(),
    }),
  },
  counterparties: {
    load: async () => (await db.counterparties.toArray()).sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    sub: (row) => [COUNTERPARTY_GROUPS.find((group) => group.type === row.type)?.label, row.note].filter(Boolean).join(', '),
    fields: (row) => [
      { key: 'name', label: 'Название', type: 'text', value: row?.name },
      {
        key: 'type',
        label: 'Тип',
        type: 'select',
        value: row?.type ?? 'supplier',
        options: COUNTERPARTY_GROUPS.map((group) => ({ value: group.type, label: group.label })),
      },
      { key: 'phone', label: 'Телефон', type: 'text', value: row?.phone, optional: true },
      { key: 'inn', label: 'ИНН', type: 'text', value: row?.inn, optional: true },
      { key: 'note', label: 'Примечание', type: 'text', value: row?.note, optional: true },
    ],
    normalize: (values) => ({ ...values, phone: values.phone ?? '', inn: values.inn ?? '', note: values.note ?? '' }),
  },
};

const NEW_TITLES = {
  accounts: 'Новый счёт', people: 'Новый человек', objects: 'Новый объект', categories: 'Новая статья', counterparties: 'Новый контрагент',
};

const ADD_LABELS = {
  accounts: 'Добавить счёт', people: 'Добавить человека', objects: 'Добавить объект', categories: 'Добавить статью', counterparties: 'Добавить контрагента',
};

async function extras() {
  const [categories, counterparties] = await Promise.all([db.categories.toArray(), db.counterparties.toArray()]);
  return { groups: new Map(categories.filter((row) => !row.parent_id).map((row) => [row.id, row])), counterparties };
}

const operationsText = (count) => `${count} ${pluralRu(count, ['операция', 'операции', 'операций'])}`;

// An article in use: first where its operations go, then one confirmation.
// Resolves to true when the article is gone.
async function deleteArticle(row) {
  const name = shortName(row.name);
  if (isSystemCategory(row)) {
    toast('Эту статью приложение ставит само. Её можно переименовать или убрать в архив.');
    return false;
  }
  const usage = await categoryUsage(row.id);
  if (usage.inClosedMonths > 0) {
    toast(`${operationsText(usage.inClosedMonths)} с этой статьёй в закрытом месяце: его отчёт не меняется`);
    return false;
  }
  const used = usage.operations + usage.templates > 0;
  let moveTo = null;
  if (used) {
    const [categories, groups] = await Promise.all([db.categories.toArray(), extras().then((extra) => extra.groups)]);
    moveTo = await openPicker({
      title: usage.operations > 0
        ? `Куда перенести ${usage.operations} ${pluralRu(usage.operations, ['операцию', 'операции', 'операций'])}`
        : 'Куда перенести регулярные платежи',
      searchPlaceholder: 'Статья',
      items: categories
        .filter((item) => item.parent_id && item.kind === row.kind && item.id !== row.id && !item.is_archived)
        .sort((a, b) => a.position - b.position)
        .map((item) => ({ id: item.id, label: shortName(item.name), sub: groups.get(item.parent_id)?.name })),
    });
    if (!moveTo) return false;
  }
  const target = moveTo && shortName((await db.categories.get(moveTo)).name);
  const moving = [
    usage.operations > 0 && operationsText(usage.operations),
    usage.templates > 0 && `${usage.templates} ${pluralRu(usage.templates, ['регулярный платёж', 'регулярных платежа', 'регулярных платежей'])}`,
  ].filter(Boolean).join(' и ');
  const confirmed = await confirmSheet({
    title: `Удалить «${name}»?`,
    message: used
      ? `В статью «${target}» перейдут: ${moving}. Вернуть обратно одним нажатием будет нельзя.`
      : 'Статьи нет ни в одной операции.',
    confirmLabel: 'Удалить',
    cancelLabel: 'Отмена',
    danger: true,
  });
  if (!confirmed) return false;
  try {
    await deleteCategory(row.id, moveTo);
  } catch (error) {
    toast(firstIssue(error));
    return false;
  }
  toast(used ? `Статья удалена, операции в «${target}»` : 'Статья удалена');
  return true;
}

// The sheet of one directory record; other screens open it too, to add an object
// where the objects are listed. Resolves to true when something was saved.
export async function editRefRow(table, row) {
  const shape = SHAPES[table];
  const storedIn = shape.table ?? table;
  const extra = await extras();
  const archived = row && isArchived(storedIn, row);
  return editSheet({
    title: row ? (shape.title?.(row) ?? row.name) : NEW_TITLES[table],
    fields: shape.fields(row, extra),
    onSave: (values) => saveRef(storedIn, row?.id ?? null, shape.normalize ? shape.normalize(values, row, extra) : values),
    extraAction: row && !row.is_overhead && [
      {
        id: 'archive-ref',
        label: archived ? 'Вернуть из архива' : 'В архив',
        run: async () => {
          await setRefArchived(storedIn, row.id, !archived);
          return true;
        },
      },
      table === 'categories' && { id: 'delete-category', label: 'Удалить статью', run: () => deleteArticle(row) },
    ],
  });
}

export function renderRefs({ view, params, isCurrent }) {
  const table = params?.get('table') ?? 'accounts';
  const shape = SHAPES[table];
  const storedIn = shape.table ?? table;

  async function edit(row) {
    if (await editRefRow(table, row)) show();
  }

  async function editGroup(group) {
    const empty = group && await db.categories.where('parent_id').equals(group.id).count() === 0;
    const saved = await editSheet({
      extraAction: empty && {
        id: 'delete-group',
        label: 'Удалить группу',
        run: async () => {
          try {
            await deleteCategoryGroup(group.id);
          } catch (error) {
            toast(firstIssue(error));
            return false;
          }
          toast('Группа удалена');
          return true;
        },
      },
      title: group ? group.name : 'Новая группа статей',
      fields: [
        { key: 'name', label: 'Название группы', type: 'text', value: group?.name },
        !group && {
          key: 'kind',
          label: 'Для чего',
          type: 'select',
          value: 'expense',
          options: [{ value: 'expense', label: 'Расходы' }, { value: 'income', label: 'Поступления' }],
        },
      ].filter(Boolean),
      onSave: (values) => saveRef('categories', group?.id ?? null, {
        name: values.name,
        kind: group?.kind ?? values.kind,
        parent_id: null,
        code: group?.code ?? null,
        position: group?.position ?? Date.now(),
      }),
    });
    if (saved) show();
  }

  function rowButton(row, extra) {
    return el('li', {}, el('button', {
      class: `row row-button${isArchived(storedIn, row) ? ' archived' : ''}`, type: 'button', 'data-ref': shape.title?.(row) ?? row.name, onClick: () => edit(row),
    },
    el('span', { class: 'row-main' },
      el('span', { class: 'row-title' }, shape.title?.(row) ?? (table === 'categories' ? shortName(row.name) : row.name)),
      el('span', { class: 'row-sub' }, [table === 'categories' ? null : shape.sub(row, extra), isArchived(storedIn, row) && 'в архиве'].filter(Boolean).join(', ')))));
  }

  // Articles go by group: a group can be renamed, and a new one added next to them.
  function groupCards(rows, extra) {
    const groups = [...extra.groups.values()].sort((a, b) => (a.kind === b.kind ? a.position - b.position : a.kind.localeCompare(b.kind)));
    return groups.map((group) => el('section', { class: 'card', 'data-group': group.name },
      el('div', { class: 'card-head' },
        el('h2', {}, group.name),
        el('button', { class: 'card-action', type: 'button', 'data-action': 'edit-group', onClick: () => editGroup(group) }, 'Изменить')),
      el('ul', { class: 'rows' }, rows.filter((row) => row.parent_id === group.id).map((row) => rowButton(row, extra)))));
  }

  async function show() {
    const [rows, extra] = await Promise.all([shape.load(), extras()]);
    if (!isCurrent()) return;
    const isCategories = table === 'categories';
    view.replaceChildren(...[
      formHead(TITLES[table], { href: '#/more' }),
      el('div', { class: isCategories ? 'tx-actions' : 'tx-actions stacked' },
        el('button', { class: 'button button-primary', type: 'button', 'data-action': 'add-ref', onClick: () => edit(null) }, ADD_LABELS[table]),
        isCategories && el('button', { class: 'button', type: 'button', 'data-action': 'add-group', onClick: () => editGroup(null) }, 'Добавить группу')),
      ...(isCategories
        ? groupCards(rows, extra)
        : [rows.length > 0
          ? el('section', { class: 'card' }, el('ul', { class: 'rows' }, rows.map((row) => rowButton(row, extra))))
          : el('p', { class: 'stub-note' }, 'Пока пусто')]),
    ]);
  }

  show();
}
