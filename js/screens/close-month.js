// Month closing: every reminder settled, actual balances compared, then the month is
// locked. Reopening needs a reason and goes to audit_log (SPEC §6).
import { photoBackup } from '../backup.js';
import { db } from '../db.js';
import {
  LedgerError, accountName, closeMonth, createCorrection, reopenMonth,
} from '../ledger.js';
import { formatDate, formatMoney, monthOf, parseAmount, todayIso } from '../money.js';
import { dueDateIn } from '../recurring.js';
import { balancesAtMonthEnd, monthInText, monthTitle, reportMonths } from '../reports.js';
import { attachAmountInput } from '../ui/amount-input.js';
import { confirmSheet } from '../ui/confirm.js';
import { el } from '../ui/dom.js';
import { askReason } from '../ui/edit-sheet.js';
import { firstIssue, formHead } from '../ui/form.js';
import { toast } from '../ui/toast.js';

async function monthToClose(periods) {
  const closed = new Set(periods.filter((period) => period.status === 'closed').map((period) => period.month));
  const months = (await reportMonths()).reverse();
  const current = monthOf(todayIso());
  return months.find((month) => !closed.has(month) && month < current) ?? current;
}

export function renderCloseMonth({ view, isCurrent }) {
  const keep = new Map();

  async function show() {
    const periods = await db.periods.toArray();
    const month = await monthToClose(periods);
    const lastDay = dueDateIn(month, 31);
    const [balances, instances, templates] = await Promise.all([
      balancesAtMonthEnd(month), db.recurring_instances.toArray(), db.recurring_templates.toArray(),
    ]);
    if (!isCurrent()) return;
    const names = new Map(templates.map((row) => [row.id, row.name]));
    const pending = instances.filter((row) => row.status === 'pending' && monthOf(row.due_date) === month);
    const inputs = new Map();

    const rows = balances.map(({ account, balance }) => {
      const difference = el('span', { class: 'row-note', 'data-difference': account.name });
      const fix = el('button', {
        class: 'mini-button',
        type: 'button',
        hidden: true,
        'data-fix': account.name,
        onClick: async () => {
          try {
            const row = await createCorrection(account.id, parseAmount(input.value) - balance, lastDay);
            toast(`Корректировка №${row.number} создана`);
            for (const [id, entry] of inputs) keep.set(id, entry.input.value);
            show();
          } catch (error) {
            toast(firstIssue(error));
          }
        },
      }, 'Создать корректировку');
      const input = el('input', {
        class: 'input close-input', type: 'text', inputMode: 'decimal', autocomplete: 'off', placeholder: 'Факт', 'aria-label': `Факт: ${account.name}`, 'data-actual': account.name,
      });
      const compare = (actual) => {
        const delta = actual === null ? null : actual - balance;
        difference.textContent = delta === null ? '' : delta === 0 ? 'Сходится' : `Расхождение ${formatMoney(delta, account.currency, { signed: true })}`;
        difference.classList.toggle('danger-text', Boolean(delta));
        fix.hidden = !delta;
      };
      attachAmountInput(input, compare);
      inputs.set(account.id, { input, account, balance });
      if (keep.has(account.id)) {
        input.value = keep.get(account.id);
        compare(parseAmount(input.value));
      }
      return el('li', { class: 'close-row' },
        el('div', { class: 'row-main' },
          el('p', { class: 'row-title' }, accountName(account)),
          el('p', { class: 'row-sub' }, `По учёту ${formatMoney(balance, account.currency)}`)),
        input,
        difference,
        fix);
    });

    async function close() {
      const missing = [...inputs.values()].find(({ input }) => parseAmount(input.value) === null);
      if (missing) {
        toast(`Введите факт: ${accountName(missing.account)}`);
        return;
      }
      await closeMonth(month, Object.fromEntries([...inputs.keys()].map((id) => [id, parseAmount(inputs.get(id).input.value)])));
      keep.clear();
      toast(`${monthTitle(month)} закрыт`);
      show();
      const wantsPhotos = await confirmSheet({
        title: 'Бэкап фото за месяц',
        message: `${monthTitle(month)} закрыт. Сохраните фото документов этого месяца в архив, это делается один раз.`,
        confirmLabel: 'Сохранить',
        cancelLabel: 'Позже',
      });
      if (wantsPhotos) await photoBackup(month).catch((error) => toast(firstIssue(error)));
    }

    async function reopen(closedMonth) {
      const reason = await askReason({
        title: `Переоткрыть ${monthInText(closedMonth)}`,
        message: 'Отчёт за этот месяц снова можно будет изменить. Причина запишется в журнал изменений.',
        confirmLabel: 'Переоткрыть',
      });
      if (!reason) return;
      try {
        await reopenMonth(closedMonth, reason);
        show();
      } catch (error) {
        if (!(error instanceof LedgerError)) throw error;
        toast(error.message);
      }
    }

    const closedMonths = periods.filter((period) => period.status === 'closed').sort((a, b) => b.month.localeCompare(a.month));

    view.replaceChildren(...[
      formHead('Закрытие месяца', { href: '#/more' }),
      el('section', { class: 'total' }, el('p', { class: 'total-value', 'data-testid': 'close-month' }, monthTitle(month))),
      pending.length > 0 && el('section', { class: 'banner column' },
        el('p', {}, 'Сначала оплатите или пропустите:'),
        pending.map((row) => el('p', { class: 'row-sub' }, `${names.get(row.template_id)}, ${formatDate(row.due_date)}`)),
        el('a', { class: 'banner-action', href: '#/recurring' }, 'К регулярным платежам')),
      el('section', { class: 'card' },
        el('div', { class: 'card-head' }, el('h2', {}, 'Фактические остатки')),
        el('p', { class: 'card-note' }, 'Пересчёт кассы, выписка банка, баланс карты'),
        el('ul', { class: 'rows' }, rows)),
      el('p', { class: 'stub-note' }, 'Расхождение: найдите ошибку или создайте корректировку по статье «Расхождение кассы».'),
      el('button', {
        class: 'button button-primary', type: 'button', disabled: pending.length > 0, 'data-action': 'close-month', onClick: close,
      }, 'Закрыть месяц'),
      closedMonths.length > 0 && el('section', { class: 'card' },
        el('div', { class: 'card-head' }, el('h2', {}, 'Закрытые месяцы')),
        el('ul', { class: 'rows' }, closedMonths.map((period) => el('li', { class: 'row row-compact', 'data-closed': period.month },
          el('p', { class: 'row-title' }, monthTitle(period.month)),
          el('button', { class: 'mini-button', type: 'button', onClick: () => reopen(period.month) }, 'Переоткрыть'))))),
    ].filter(Boolean));
  }

  show();
}
