// A short form in a bottom sheet, for directories and barter steps. Fields:
// { key, label, type: 'text'|'number'|'amount'|'rate'|'date'|'select'|'pick'|'counterparty', value, options, optional, hint }.
// 'pick' chooses from `options` in a picker with search, like the forms do; options
// may carry `sub` and `group`. 'counterparty' is a pick where a typed name that is
// not there becomes a new counterparty of `counterpartyType` when the sheet is saved.
// Short fixed lists (currency, document type) stay a plain 'select'.
import { ensureCounterparty } from '../ledger.js';
import { amountToTyping, formatRate, formatTyping, parseAmount, parseRate } from '../money.js';
import { confirmSheet } from './confirm.js';
import { el } from './dom.js';
import { firstIssue, withConfirmations } from './form.js';
import { openPicker } from './picker.js';
import { openSheet } from './sheet.js';

const NONE = 'none';

function pickControl(field) {
  const canCreate = field.type === 'counterparty';
  // The only possible answer to a required question is given at once. Not for people:
  // the one buyer on record is rarely the next one.
  const only = !canCreate && !field.optional && field.options.length === 1 ? field.options[0].value : null;
  const picked = { id: field.value ?? only, create: null };
  const button = el('button', {
    class: 'input input-pick', type: 'button', 'data-key': field.key, 'aria-label': field.label, onClick: choose,
  });

  function show() {
    const option = field.options.find((item) => item.value === picked.id);
    const label = picked.create ?? option?.label;
    button.replaceChildren(...[
      el('span', { class: label ? 'pick-value' : 'pick-placeholder' }, label ?? (canCreate ? 'Выбрать или добавить' : 'Выбрать')),
      picked.create && el('span', { class: 'pick-new' }, 'новый'),
      !picked.create && option?.sub && el('span', { class: 'pick-sub' }, option.sub),
    ].filter(Boolean));
  }

  async function choose() {
    const result = await openPicker({
      title: field.label,
      items: [
        ...(field.optional && (picked.id || picked.create) ? [{ id: NONE, label: 'Не указано' }] : []),
        ...field.options.map((option) => ({ id: option.value, label: option.label, sub: option.sub, group: option.group })),
      ],
      selectedId: picked.id,
      searchPlaceholder: canCreate ? 'Имя или название' : 'Поиск',
      canCreate,
      createLabel: field.createLabel ?? 'Добавить',
      autofocus: canCreate || field.options.length > 8,
    });
    if (!result) return;
    picked.id = result.create || result === NONE ? null : result;
    picked.create = result.create ?? null;
    show();
    field.onPick?.(picked.id);
  }

  show();
  // Read by readValue; a new name is turned into a record only on save.
  button.pickedValue = () => picked.id ?? (picked.create ? { create: picked.create } : null);
  button.settle = (id) => {
    picked.id = id;
    picked.create = null;
  };
  return button;
}

function control(field) {
  if (field.type === 'pick' || field.type === 'counterparty') return pickControl(field);
  if (field.type === 'select') {
    return el('select', { class: 'input', 'data-key': field.key, 'aria-label': field.label },
      field.optional && el('option', { value: '' }, 'Не указано'),
      field.options.map(({ value, label }) => el('option', { value, selected: value === field.value }, label)));
  }
  const numeric = field.type === 'amount' || field.type === 'rate' || field.type === 'number';
  const input = el('input', {
    class: 'input',
    'data-key': field.key,
    type: field.type === 'date' ? 'date' : 'text',
    inputMode: numeric ? 'decimal' : null,
    autocomplete: 'off',
    'aria-label': field.label,
  });
  if (field.type === 'amount') {
    input.value = field.value != null ? amountToTyping(field.value) : '';
    input.addEventListener('input', () => {
      input.value = formatTyping(input.value);
    });
  } else if (field.type === 'rate') {
    input.value = field.value ? formatRate(field.value) : '';
  } else {
    input.value = field.value ?? '';
  }
  return input;
}

function readValue(field, node) {
  if (field.type === 'pick' || field.type === 'counterparty') return node.pickedValue();
  const raw = node.value;
  if (field.type === 'amount') return parseAmount(raw);
  if (field.type === 'rate') return parseRate(raw);
  if (field.type === 'number') return raw.trim() === '' ? null : Number(raw);
  return raw === '' ? null : raw;
}

// onSave(values, { confirmed }) closes the sheet unless it throws.
export function editSheet({ title, fields, saveLabel = 'Сохранить', onSave, extraAction = null, secondAction = null }) {
  return new Promise((resolve) => {
    const controls = new Map(fields.map((field) => [field.key, control(field)]));
    const error = el('p', { class: 'field-error', hidden: true });

    async function save() {
      const values = Object.fromEntries(fields.map((field) => [field.key, readValue(field, controls.get(field.key))]));
      const missing = fields.find((field) => !field.optional && (values[field.key] == null || values[field.key] === ''));
      if (missing) {
        error.textContent = `Заполните: ${missing.label}`;
        error.hidden = false;
        return;
      }
      try {
        // New names become records right before saving; a retry reuses them.
        for (const field of fields.filter((item) => item.type === 'counterparty' && values[item.key]?.create)) {
          const row = await ensureCounterparty(values[field.key].create, field.counterpartyType);
          controls.get(field.key).settle(row.id);
          values[field.key] = row.id;
        }
        const result = await withConfirmations((options) => onSave(values, options));
        if (result !== null) sheet.close(true);
      } catch (failure) {
        error.textContent = firstIssue(failure);
        error.hidden = false;
      }
    }

    const sheet = openSheet({
      title,
      onClose: (saved) => resolve(saved === true),
      body: el('div', { class: 'edit-sheet' },
        el('div', { class: 'edit-fields' }, fields.map((field) => el('label', { class: 'edit-field' },
          el('span', { class: 'chips-label' }, field.optional ? `${field.label}, необязательно` : field.label),
          controls.get(field.key),
          field.hint && el('span', { class: 'field-hint' }, field.hint)))),
        error,
        el('div', { class: 'sheet-save-bar' }, el('button', { class: 'button button-primary', type: 'button', 'data-action': 'sheet-save', onClick: save }, saveLabel)),
        secondAction && el('button', { class: 'list-action', type: 'button', 'data-action': 'sheet-second', onClick: () => secondAction.run() }, secondAction.label),
        extraAction && el('button', {
          class: 'list-action danger',
          type: 'button',
          onClick: async () => {
            if (await extraAction.run()) sheet.close(true);
          },
        }, extraAction.label)),
    });
  });
}

export async function askReason({ title, message, label = 'Причина', confirmLabel = 'Подтвердить' }) {
  const input = el('input', { class: 'input', type: 'text', autocomplete: 'off', placeholder: label, 'aria-label': label, 'data-key': 'reason' });
  const error = el('p', { class: 'field-error', hidden: true }, 'Причина обязательна');
  return new Promise((resolve) => {
    const sheet = openSheet({
      title,
      onClose: (value) => resolve(value ?? null),
      body: el('div', { class: 'edit-sheet' },
        el('p', { class: 'confirm-text' }, message),
        input,
        error,
        el('button', {
          class: 'button button-danger',
          type: 'button',
          'data-action': 'sheet-save',
          onClick: () => {
            if (input.value.trim()) sheet.close(input.value.trim());
            else error.hidden = false;
          },
        }, confirmLabel)),
    });
    input.focus();
  });
}

export { confirmSheet };
