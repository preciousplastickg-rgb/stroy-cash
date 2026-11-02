// PIN of four digits: asks at start and after five minutes in the background.
import { setPin, verifyPin } from '../security.js';
import { el } from '../ui/dom.js';

const LENGTH = 4;

// mode 'verify' checks the PIN, mode 'set' asks twice and stores it.
export function showPinScreen({ mode = 'verify', onDone, onCancel = null }) {
  let entered = '';
  let first = null;
  const heading = el('h1', {}, mode === 'set' ? 'Придумайте PIN' : 'Введите PIN');
  const message = el('p', { class: 'pin-message' });
  const dots = el('div', { class: 'pin-dots', 'aria-hidden': 'true' });

  function paint() {
    dots.replaceChildren(...Array.from({ length: LENGTH }, (_, index) => el('span', { class: `pin-dot${index < entered.length ? ' filled' : ''}` })));
  }

  function finish() {
    screen.remove();
    onDone();
  }

  async function submit() {
    if (mode === 'verify') {
      if (await verifyPin(entered)) {
        finish();
        return;
      }
      message.textContent = 'Неверный PIN';
    } else if (first === null) {
      first = entered;
      heading.textContent = 'Повторите PIN';
      message.textContent = '';
    } else if (first === entered) {
      await setPin(entered);
      finish();
      return;
    } else {
      first = null;
      heading.textContent = 'Придумайте PIN';
      message.textContent = 'PIN не совпал, попробуйте ещё раз';
    }
    entered = '';
    paint();
  }

  function press(digit) {
    if (entered.length === LENGTH) return;
    entered += digit;
    paint();
    if (entered.length === LENGTH) submit();
  }

  function erase() {
    entered = entered.slice(0, -1);
    paint();
  }

  const digitKey = (digit) => el('button', { class: 'pin-key', type: 'button', 'data-digit': digit, onClick: () => press(digit) }, digit);
  const screen = el('div', { class: 'pin-screen', role: 'dialog', 'aria-label': 'PIN' },
    heading,
    dots,
    message,
    el('div', { class: 'pin-keys' },
      ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(digitKey),
      onCancel
        ? el('button', {
          class: 'pin-key small',
          type: 'button',
          onClick: () => {
            screen.remove();
            onCancel();
          },
        }, 'Отмена')
        : el('span', {}),
      digitKey('0'),
      el('button', { class: 'pin-key small', type: 'button', 'aria-label': 'Стереть', onClick: erase }, 'Стереть')));
  paint();
  document.body.append(screen);
}
