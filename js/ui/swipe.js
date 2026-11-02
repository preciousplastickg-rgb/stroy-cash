// Horizontal swipes on the screen. On an inner screen a swipe to the right goes
// back; on a tab it flips to the neighbouring tab. The screen follows the finger
// and the transition continues from where the finger let go.

const DECIDE_PX = 10;
const COMMIT_SHARE = 0.32;
const COMMIT_SPEED = 0.4; // px per ms
const RESIST = 0.25;
const RESIST_MAX = 48;
const EDGE_PX = 24;

const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
// Safari in the browser has its own edge swipe for back and forward.
const browserEdgeSwipe = /iP(hone|od|ad)/.test(navigator.userAgent) && !standalone;

function blockedBy(target, root) {
  for (let node = target; node && node !== root; node = node.parentElement) {
    if (node.matches('input, textarea, select, [data-no-swipe]')) return true;
    if (node.scrollWidth > node.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(node).overflowX)) return true;
  }
  return false;
}

// options.allowed() → { back, prev, next } for the current screen;
// options.commit(kind, offset) with kind 'back' | 'prev' | 'next'; false keeps the screen.
// options.track(offset, allowed) follows the finger; options.cancel() when it lets go short.
export function attachSwipes(view, {
  movable, allowed, commit, disabled, track = () => {}, cancel = () => {},
}) {
  let gesture = null;

  const move = (x) => {
    for (const node of movable()) node.style.transform = x ? `translateX(${x}px)` : '';
  };

  function settle(from) {
    cancel();
    const nodes = movable();
    for (const node of nodes) {
      node.style.transform = '';
      node.animate([{ transform: `translateX(${from}px)` }, { transform: 'translateX(0)' }], { duration: 200, easing: 'cubic-bezier(.2, .8, .2, 1)' });
    }
    view.classList.remove('swiping');
  }

  view.addEventListener('touchstart', (event) => {
    gesture = null;
    if (event.touches.length !== 1 || disabled()) return;
    const touch = event.touches[0];
    if (browserEdgeSwipe && (touch.clientX < EDGE_PX || touch.clientX > innerWidth - EDGE_PX)) return;
    if (blockedBy(event.target, view)) return;
    gesture = { x: touch.clientX, y: touch.clientY, state: 'pending', allowed: allowed(), samples: [] };
  }, { passive: true });

  view.addEventListener('touchmove', (event) => {
    if (!gesture || gesture.state === 'scroll') return;
    if (event.touches.length !== 1) {
      if (gesture.state === 'drag') settle(gesture.offset);
      gesture = null;
      return;
    }
    const touch = event.touches[0];
    const dx = touch.clientX - gesture.x;
    const dy = touch.clientY - gesture.y;
    if (gesture.state === 'pending') {
      if (Math.abs(dx) < DECIDE_PX && Math.abs(dy) < DECIDE_PX) return;
      const { back, prev, next } = gesture.allowed;
      if (Math.abs(dx) < Math.abs(dy) * 1.2 || !(back || prev || next)) {
        gesture.state = 'scroll';
        return;
      }
      gesture.state = 'drag';
      gesture.x = touch.clientX; // no jump by the decision distance
      document.activeElement?.blur?.();
      view.classList.add('swiping');
    }
    event.preventDefault();
    const raw = touch.clientX - gesture.x;
    const { back, prev, next } = gesture.allowed;
    const free = raw > 0 ? back || prev : next;
    gesture.offset = free ? raw : Math.sign(raw) * Math.min(Math.abs(raw) * RESIST, RESIST_MAX);
    gesture.samples.push({ x: touch.clientX, t: event.timeStamp });
    if (gesture.samples.length > 5) gesture.samples.shift();
    move(gesture.offset);
    track(gesture.offset, gesture.allowed);
  }, { passive: false });

  function end() {
    if (gesture?.state !== 'drag') {
      gesture = null;
      return;
    }
    const { offset = 0, samples, allowed: { back, prev, next } } = gesture;
    gesture = null;
    const first = samples[0];
    const last = samples.at(-1);
    const speed = first && last && last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
    const far = Math.abs(offset) > view.clientWidth * COMMIT_SHARE;
    const flung = Math.abs(speed) > COMMIT_SPEED && Math.sign(speed) === Math.sign(offset);
    let kind = null;
    if (far || flung) {
      if (offset > 0 && back) kind = 'back';
      else if (offset > 0 && prev) kind = 'prev';
      else if (offset < 0 && next) kind = 'next';
    }
    view.classList.remove('swiping');
    // commit() returns false when the screen stays, for example to ask about unsaved input.
    if (!kind || commit(kind, offset) === false) settle(offset);
  }

  view.addEventListener('touchend', end);
  view.addEventListener('touchcancel', end);
}
