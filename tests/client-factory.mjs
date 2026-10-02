// Dry-run of the built client bundle: executes lib/client.js through a stubbed
// ModuleLoader + require scope and asserts the plugin object shape and slot
// registrations. Catches "createPlugin is not defined" class breakage without
// the real DSH renderer. Run: node tests/client-factory.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const lib = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib');
const code = readFileSync(path.join(lib, 'client.js'), 'utf8');

function makeReactStub() {
  const createElement = (type, props, ...children) => ({ type, props, children });
  return {
    __esModule: true,
    default: { createElement },
    createElement,
    Fragment: 'Fragment',
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v }),
  };
}
function makePrimitivesStub() {
  const component = (name) => function Stub() { return { stub: name }; };
  return {
    __esModule: true,
    MenuItemButton: component('MenuItemButton'),
    Modal: component('Modal'),
    Button: component('Button'),
    IconTrashOutlineRegular: component('IconTrashOutlineRegular'),
    IconEllipsisOutlineRegular: component('IconEllipsisOutlineRegular'),
  };
}

let loaded = null;
const fakeWindow = {
  __ModuleLoader__: {
    load({ id, factory }) {
      loaded = { id, plugin: factory(makeRequireStub()) };
    },
  },
};
function makeRequireStub() {
  return (name) => {
    if (name === 'react') return makeReactStub();
    if (name === 'react-dom') return { __esModule: true, createPortal: () => null };
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return makePrimitivesStub();
    throw new Error(`unexpected require in client bundle: ${name}`);
  };
}

const fakeWindowProxy = new Proxy(fakeWindow, { get: (t, k) => t[k] });
new Function('window', code)(fakeWindowProxy);

assert.ok(loaded, 'ModuleLoader.load was called');
assert.equal(loaded.id, 'dsh-plugin-session-trash');
const plugin = loaded.plugin;
assert.equal(typeof plugin?.apply, 'function', 'plugin.apply exists');
assert.deepEqual(plugin.inject, ['slots', 'sessions', 'locale', 'remote']);

// Run apply against a stub ctx and check the three slot registrations.
const registered = [];
const injected = [];
const ctx = {
  root: {},
  locale: { getSnapshot: () => ({ active: 'zh-CN' }), subscribe: () => () => {} },
  slots: {
    inject(name, factory) { injected.push(name); factory(); },
    register(options, component) {
      registered.push(options);
      assert.equal(typeof component, 'function');
    },
  },
};
plugin.apply(ctx);
assert.deepEqual(injected, [
  'sidebar.workspaces.session.menu.item',
  'shell.overlay',
  'settings.section',
]);
assert.deepEqual(registered.map((o) => o.id), ['trash', 'session-trash-dialog', 'session-trash']);
assert.deepEqual(registered.map((o) => o.order), [450, 95, 30]);

console.log('client-factory: all assertions passed');
