// Money, rates and dates. Amounts are integers in minor units (tyiyn, cents),
// rate is an integer scaled by RATE_SCALE. No float arithmetic on money here.

export const RATE_SCALE = 10000;
export const RATE_ONE = RATE_SCALE;

const NBSP = ' ';
const MINUS = '−';

function parseScaled(input, decimals) {
  if (input == null) return null;
  const compact = String(input).replace(/[\s   ]/g, '');
  const match = compact.match(/^(\d*)(?:[.,](\d*))?$/);
  if (!match) return null;
  const whole = match[1];
  const frac = match[2] ?? '';
  if (!whole && !frac) return null;
  if (frac.length > decimals) return null;
  const value = Number(whole + frac.padEnd(decimals, '0'));
  return Number.isSafeInteger(value) ? value : null;
}

// "1 234,5" -> 123450. Returns null if the text is not an amount.
export function parseAmount(input) {
  return parseScaled(input, 2);
}

// "87,45" -> 874500.
export function parseRate(input) {
  return parseScaled(input, 4);
}

function divideRounded(numerator, denominator) {
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  const negative = n < 0n !== d < 0n;
  const absN = n < 0n ? -n : n;
  const absD = d < 0n ? -d : d;
  const rounded = (absN * 2n + absD) / (absD * 2n);
  return Number(negative ? -rounded : rounded);
}

// Half away from zero. BigInt keeps precision for amount * rate above 2^53.
export function toKgs(amount, rate) {
  return divideRounded(BigInt(amount) * BigInt(rate), RATE_SCALE);
}

// Rate implied by an exchange: kgs and usd are both minor units.
export function rateFromAmounts(kgsAmount, usdAmount) {
  return divideRounded(BigInt(kgsAmount) * BigInt(RATE_SCALE), usdAmount);
}

// The only place amount_kgs is calculated. In an exchange the KGS side is the
// real number of soms that moved, so it wins over amount * rate.
export function computeAmountKgs({ currency, amount, rate, toCurrency = null, toAmount = null }) {
  if (currency === 'KGS') return amount;
  if (toCurrency === 'KGS') return toAmount;
  return toKgs(amount, rate);
}

function groupThousands(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

function formatMinor(minor) {
  const digits = String(Math.abs(minor)).padStart(3, '0');
  const whole = groupThousands(digits.slice(0, -2));
  const frac = digits.slice(-2);
  return frac === '00' ? whole : `${whole},${frac}`;
}

// "1 234 567,50 сом", "$10 000". signed: true adds a plus to positive amounts.
export function formatMoney(minor, currency, { signed = false } = {}) {
  const sign = minor < 0 ? MINUS : signed && minor > 0 ? '+' : '';
  const body = formatMinor(minor);
  return currency === 'USD' ? `${sign}$${body}` : `${sign}${body}${NBSP}сом`;
}

// 874500 -> "87,45", 874520 -> "87,452".
export function formatRate(rate) {
  const digits = String(rate).padStart(5, '0');
  const whole = digits.slice(0, -4);
  const frac = digits.slice(-4).replace(/0{1,2}$/, '').replace(/0$/, (zero, index) => (index < 2 ? zero : ''));
  return `${whole},${frac.padEnd(2, '0')}`;
}

// Live formatting for an amount field: digits grouped, a single comma, two decimals.
export function formatTyping(raw) {
  const text = String(raw).replace(/[^\d.,]/g, '').replace(/\./g, ',');
  const commaAt = text.indexOf(',');
  const whole = (commaAt === -1 ? text : text.slice(0, commaAt)).replace(/^0+(?=\d)/, '');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  if (commaAt === -1) return grouped;
  const frac = text.slice(commaAt + 1).replace(/,/g, '').slice(0, 2);
  return `${grouped || '0'},${frac}`;
}

// Stored amount back into the text of an amount field.
export function amountToTyping(minor) {
  const digits = String(minor).padStart(3, '0');
  const frac = digits.slice(-2);
  return formatTyping(frac === '00' ? digits.slice(0, -2) : `${digits.slice(0, -2)},${frac}`);
}

const ONES = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const ONES_FEMININE = ['', 'одна', 'две', ...ONES.slice(3)];
const TEENS = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];
const SCALES = [
  { forms: ['тысяча', 'тысячи', 'тысяч'], feminine: true },
  { forms: ['миллион', 'миллиона', 'миллионов'], feminine: false },
  { forms: ['миллиард', 'миллиарда', 'миллиардов'], feminine: false },
];

function pluralRu(n, [one, few, many]) {
  const lastTwo = n % 100;
  const last = n % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

function tripletWords(n, feminine) {
  const words = [HUNDREDS[Math.floor(n / 100)]];
  const rest = n % 100;
  if (rest >= 10 && rest < 20) {
    words.push(TEENS[rest - 10]);
  } else {
    words.push(TENS[Math.floor(rest / 10)]);
    words.push((feminine ? ONES_FEMININE : ONES)[rest % 10]);
  }
  return words.filter(Boolean);
}

function integerWords(n) {
  if (n === 0) return 'ноль';
  const parts = [];
  let remaining = n;
  let scale = -1;
  while (remaining > 0) {
    const triplet = remaining % 1000;
    if (triplet > 0) {
      const info = SCALES[scale];
      const words = tripletWords(triplet, info?.feminine ?? false);
      if (info) words.push(pluralRu(triplet, info.forms));
      parts.unshift(words.join(' '));
    }
    remaining = Math.floor(remaining / 1000);
    scale += 1;
  }
  return parts.join(' ');
}

const UNITS = {
  KGS: { major: ['сом', 'сома', 'сомов'], minor: ['тыйын', 'тыйына', 'тыйынов'] },
  USD: { major: ['доллар', 'доллара', 'долларов'], minor: ['цент', 'цента', 'центов'] },
};

// 60000000 KGS -> "Шестьсот тысяч сомов". Used to catch an extra zero.
export function amountInWords(minor, currency) {
  const units = UNITS[currency];
  const digits = String(Math.abs(minor)).padStart(3, '0');
  const whole = Number(digits.slice(0, -2));
  const frac = Number(digits.slice(-2));
  let text = `${integerWords(whole)} ${pluralRu(whole, units.major)}`;
  if (frac > 0) text += ` ${frac} ${pluralRu(frac, units.minor)}`;
  return text[0].toUpperCase() + text.slice(1);
}

// Operation dates are local calendar days stored as "YYYY-MM-DD".
export function todayIso(now = new Date()) {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

export function monthOf(date) {
  return date.slice(0, 7);
}

function dayNumber(date) {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day) / 86400000;
}

export function daysBetween(from, to) {
  return dayNumber(to) - dayNumber(from);
}

export function addDays(date, days) {
  return new Date((dayNumber(date) + days) * 86400000).toISOString().slice(0, 10);
}

export function formatDate(date) {
  const [year, month, day] = date.split('-');
  return `${day}.${month}.${year}`;
}

const MONTHS_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

// "1 ноября"
export function formatDayMonth(date) {
  const [, month, day] = date.split('-').map(Number);
  return `${day} ${MONTHS_GENITIVE[month - 1]}`;
}

// "ноябрь"
export function monthName(month) {
  return MONTHS[Number(month.slice(5, 7)) - 1];
}
