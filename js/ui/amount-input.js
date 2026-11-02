import { formatTyping, parseAmount } from '../money.js';

// Groups thousands while typing and keeps the caret next to the same digit.
export function attachAmountInput(input, onChange) {
  input.addEventListener('input', () => {
    const typedBeforeCaret = input.value.slice(0, input.selectionStart).replace(/[^\d.,]/g, '').length;
    const formatted = formatTyping(input.value);
    input.value = formatted;
    let caret = 0;
    let seen = 0;
    while (caret < formatted.length && seen < typedBeforeCaret) {
      if (formatted[caret] !== ' ') seen += 1;
      caret += 1;
    }
    input.setSelectionRange(caret, caret);
    onChange?.(parseAmount(formatted));
  });
}
