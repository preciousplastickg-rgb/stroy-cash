// Navigation on top of browser history. Every entry carries { key, depth }: depth
// counts the app's own entries below it, so "back" never leaves the app and a
// screen's back button returns to whatever screen opened it, not to a fixed one.
// Open sheets take a history entry too: the Android back button and the back swipe
// close the sheet instead of the screen under it.

const TABS = ['/', '/journal', '/objects', '/reports', '/more'];

let onLeave = () => {};
let onEnter = () => {};
let entry = null;
let shownUrl = '';
let guard = null;
let bypassGuard = false;
let pendingOffset = 0; // how far a back swipe already moved the screen
const overlays = [];
const waiters = []; // the history.go() whose popstate has not arrived yet
let traversals = 0; // history.go() calls queued or in flight
let chain = Promise.resolve();
let idle = [];

function newKey() {
  return crypto.randomUUID().slice(0, 8);
}

function currentHashPath() {
  return location.hash.replace(/^#/, '') || '/';
}

function flushIdle() {
  while (traversals === 0 && idle.length > 0) idle.shift()();
}

// History calls are asynchronous. Everything that pushes waits for earlier
// traversals to land, otherwise a push could be undone by a late back().
function whenIdle(run) {
  if (traversals === 0) run();
  else idle.push(run);
}

// One traversal at a time: WebKit merges a go() made while another is in flight.
function traverse(delta) {
  traversals += 1;
  chain = chain.then(() => new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      const index = waiters.indexOf(done);
      if (index >= 0) waiters.splice(index, 1);
      resolve();
    };
    // A traversal past the start of history never fires popstate.
    const timer = setTimeout(done, 800);
    waiters.push(done);
    history.go(delta);
  })).then(() => {
    traversals -= 1;
    flushIdle();
  });
  return chain;
}

function show(direction, options = {}) {
  shownUrl = location.href;
  onEnter(direction, entry.key, options);
}

function leave() {
  onLeave(entry.key);
  guard = null;
}

function closeOverlaysAbove(level) {
  while (overlays.length > level) {
    const overlay = overlays.pop();
    overlay.active = false;
    overlay.onPop();
  }
}

// Closes every open sheet together with its history entries.
function dropOverlays() {
  const pushed = overlays.filter((overlay) => overlay.pushed).length;
  closeOverlaysAbove(0);
  if (pushed > 0) traverse(-pushed);
}

async function confirmLeave() {
  const { confirmSheet } = await import('./ui/confirm.js');
  return confirmSheet({
    title: 'Выйти без сохранения?', message: 'Введённые данные не сохранятся.', confirmLabel: 'Выйти', cancelLabel: 'Остаться', danger: true,
  });
}

function onPop() {
  const state = history.state;
  if (waiters.length > 0) {
    if (state?.key) entry = state;
    waiters[0]();
    return;
  }
  if (!state?.key) {
    // The hash was changed from outside the router: a new screen on top.
    closeOverlaysAbove(0);
    leave();
    history.replaceState({ key: newKey(), depth: entry.depth + 1, parent: entry.key }, '');
    entry = history.state;
    show('forward');
    return;
  }
  if (state.key === entry.key) {
    // Same screen: the back button closed a sheet.
    closeOverlaysAbove(state.overlay ?? 0);
    entry = state;
    return;
  }
  if (guard?.() && !bypassGuard) {
    // A form with unsaved input: put its entry back and ask first.
    history.pushState(entry, '', shownUrl);
    confirmLeave().then((leaveForm) => {
      if (!leaveForm) return;
      whenIdle(() => {
        bypassGuard = true;
        history.back();
      });
    });
    return;
  }
  bypassGuard = false;
  closeOverlaysAbove(0);
  const direction = state.depth < entry.depth ? 'back' : 'forward';
  const offset = pendingOffset;
  pendingOffset = 0;
  leave();
  entry = state;
  show(direction, { offset });
}

export function initNav({ leave: leaveHook, enter }) {
  onLeave = leaveHook;
  onEnter = enter;
  const state = history.state;
  // A reload keeps the stack; a sheet that was open is gone, so is its entry's meaning.
  history.replaceState(state?.key ? { key: state.key, depth: state.depth, parent: state.parent } : { key: newKey(), depth: 0 }, '');
  entry = history.state;
  window.addEventListener('popstate', onPop);
}

export function firstShow(path) {
  if (path && path !== currentHashPath()) history.replaceState(entry, '', `#${path}`);
  show('none');
}

export function currentDepth() {
  return entry.depth;
}

// The screen under this one, for a look at it during a back swipe.
export function parentKey() {
  return entry.parent ?? null;
}

export function isTab(path) {
  return TABS.includes(path);
}

export function tabIndex(path) {
  return TABS.indexOf(path);
}

export function tabAt(index) {
  return TABS[index] ?? null;
}

// A screen with unsaved input registers a check; leaving then asks first.
export function setLeaveGuard(check) {
  guard = check;
}

export function hasUnsavedInput() {
  return Boolean(guard?.());
}

export function navigate(path, { replace = false, direction = null, offset = 0 } = {}) {
  if (overlays.length > 0) dropOverlays();
  whenIdle(() => {
    leave();
    const state = replace
      ? { key: newKey(), depth: entry.depth, parent: entry.parent }
      : { key: newKey(), depth: entry.depth + 1, parent: entry.key };
    if (replace) history.replaceState(state, '', `#${path}`);
    else history.pushState(state, '', `#${path}`);
    entry = state;
    show(direction ?? (replace ? 'fade' : 'forward'), { offset });
  });
}

// Back to the screen that opened this one; with nothing under it, to the fallback.
export function goBack(fallback = '/', options = {}) {
  whenIdle(async () => {
    if (guard?.()) {
      if (!(await confirmLeave())) return;
      guard = null;
    }
    // The confirmation's own entry is still being removed.
    whenIdle(() => {
      if (entry.depth > 0) {
        bypassGuard = true;
        pendingOffset = options.offset ?? 0;
        history.back();
      } else {
        navigate(fallback, { replace: true, direction: 'back', offset: options.offset ?? 0 });
      }
    });
  });
}

// Bottom navigation: a tab sits right on top of the home screen, so back from any
// tab goes home and back from home leaves the app.
export function switchTab(path, { direction = 'fade', offset = 0 } = {}) {
  if (overlays.length > 0) dropOverlays();
  whenIdle(async () => {
    const depth = entry.depth;
    leave();
    if (path === '/') {
      if (depth > 0) await traverse(-depth);
      if (currentHashPath() !== '/') history.replaceState(entry, '', '#/');
    } else {
      if (depth > 1) await traverse(-(depth - 1));
      // From home the tab goes on top; otherwise it takes the place of the tab there.
      const onHome = entry.depth === 0 && currentHashPath() === '/';
      const state = onHome ? { key: newKey(), depth: 1, parent: entry.key } : { key: newKey(), depth: entry.depth, parent: entry.parent };
      if (onHome) history.pushState(state, '', `#${path}`);
      else history.replaceState(state, '', `#${path}`);
      entry = state;
    }
    show(direction, { offset });
  });
}

// A sheet registers here when it opens. onPop closes it when the back button pops
// its entry; the returned release() is called when the sheet closes by itself.
export function pushOverlay(onPop) {
  const overlay = { onPop, active: true, pushed: false };
  overlays.push(overlay);
  const level = overlays.length;
  whenIdle(() => {
    if (!overlay.active) return;
    history.pushState({
      key: entry.key, depth: entry.depth, parent: entry.parent, overlay: level,
    }, '');
    entry = history.state;
    overlay.pushed = true;
  });
  return () => {
    if (!overlay.active) return;
    overlay.active = false;
    overlays.splice(overlays.indexOf(overlay), 1);
    if (overlay.pushed) traverse(-1);
  };
}

export function hasOverlay() {
  return overlays.length > 0;
}

// Keeps the screen's own state (filters, search) in its address, so that coming
// back to it, or reloading, shows the same thing.
export function replaceParams(path, params) {
  const query = params.toString();
  // After a sheet closes its entry is still current for a moment: wait until it is gone.
  whenIdle(() => {
    history.replaceState(entry, '', `#${path}${query ? `?${query}` : ''}`);
    shownUrl = location.href;
  });
}
