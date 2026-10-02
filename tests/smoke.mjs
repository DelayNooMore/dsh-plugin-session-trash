// Smoke test: runs the host half against a temp DSH_HOME with a scripted
// workspaceRegistry. Exercises trash/restore/purge/purgeAll/list and the
// in-turn busy guard. Run: node tests/smoke.mjs
import { promises as fsp } from 'node:fs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-trash-test-'));
process.env.DSH_HOME = home;

const sessionsProject = path.join(home, 'sessions', '--tmp-ws--');
const statePath = path.join(home, 'storages', 'workspace.json');
async function makeSession(sessionId, { lock = false, archived = false, attached = true } = {}) {
  const dir = path.join(sessionsProject, sessionId);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'session.jsonl.zstd'), `payload:${sessionId}`);
  if (lock) await fsp.writeFile(path.join(dir, 'session.lock'), '');
  await fsp.mkdir(path.dirname(statePath), { recursive: true });
  const state = {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      workspaceIds: ['ws-1'],
      archivedSessionIds: archived ? [sessionId] : [],
      pinnedSessionIds: [],
    },
    tables: {
      workspaces: {
        'ws-1': { path: '/tmp/ws', title: 'WS', sessionIds: attached ? [sessionId] : [], createdAt: '', updatedAt: '' },
      },
    },
  };
  await fsp.writeFile(statePath, JSON.stringify(state));
  return dir;
}

const calls = { detach: 0, unarchive: 0, unpin: 0, attach: 0, create: 0 };
// State-driven mock: entity getters read the persisted workspace.json, and the
// registry methods mutate it, mirroring the real registry's semantics.
function loadState() {
  try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return null; }
}
function saveState(state) {
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state));
}
function makeRegistry() {
  const entity = {
    get sessionIds() { return loadState()?.tables?.workspaces?.['ws-1']?.sessionIds ?? []; },
    get path() { return loadState()?.tables?.workspaces?.['ws-1']?.path ?? null; },
    get title() { return loadState()?.tables?.workspaces?.['ws-1']?.title ?? null; },
    async detachSession(id) {
      calls.detach += 1;
      const state = loadState();
      const ws = state.tables.workspaces['ws-1'];
      ws.sessionIds = ws.sessionIds.filter((x) => x !== id);
      saveState(state);
    },
    async attachSession(id) {
      calls.attach += 1;
      const state = loadState();
      state.tables.workspaces['ws-1'].sessionIds.push(id);
      saveState(state);
    },
  };
  return {
    entity,
    list: () => [entity],
    async unarchiveSession(id) {
      calls.unarchive += 1;
      const state = loadState();
      state.global.archivedSessionIds = state.global.archivedSessionIds.filter((x) => x !== id);
      saveState(state);
    },
    async unpinSession(id) {
      calls.unpin += 1;
      const state = loadState();
      state.global.pinnedSessionIds = state.global.pinnedSessionIds.filter((x) => x !== id);
      saveState(state);
    },
    async resolveByPath(p) { return entity.path === p ? entity : undefined; },
    async create(p, title) {
      calls.create += 1;
      const state = loadState();
      const ws = state.tables.workspaces['ws-1'];
      ws.path = p;
      ws.title = title;
      saveState(state);
      return entity;
    },
  };
}

const registry = makeRegistry();
const handlers = {};
const provided = {};
// Mock of the host `sessions` service: live entries with a working detach.
const live = new Map();
const sessionsService = {
  store: live,
  get: (id) => live.get(id)?.session,
  list: () => [...live.values()].map((e) => e.session),
};
function makeLive(sessionId) {
  live.set(sessionId, {
    session: { id: sessionId },
    detach: () => { live.delete(sessionId); },
  });
}
const ctx = {
  get: (n) => (n === 'workspaceRegistry' ? registry : n === 'sessions' ? sessionsService : undefined),
  on: (name, fn) => { handlers[name] = fn; return () => {}; },
  provide: (n, s) => { provided[n] = s; },
  effect: () => {},
};

const { apply } = await import('../src/index.js');
apply(ctx);
const service = provided.sessionTrash;
assert.equal(typeof service?.trash, 'function', 'service provided');
assert.equal(service.typertRemote.namespace, 'sessionTrash');
assert.equal(service.typertRemote.serviceKey, 'sessionTrash');

const emit = (sessionId, type) => handlers['session/event']({ id: sessionId }, { type });

// 1) busy guard
await makeSession('session-busy');
emit('session-busy', 'turn/start');
let result = await service.trash({ sessionId: 'session-busy' });
assert.equal(result.ok, false);
assert.equal(result.reason, 'busy');
emit('session-busy', 'turn/end');

// 2) trash: detach + move + manifest + stale lock cleanup (+ live eviction)
await makeSession('session-a', { lock: true });
makeLive('session-a');
result = await service.trash({ sessionId: 'session-a', displayTitle: '测试会话' });
assert.equal(result.ok, true, `trash failed: ${JSON.stringify(result)}`);
assert.equal(result.alreadyGone, false);
assert.equal(result.lingerUntilRestart, false, 'warm session evicted from live set');
assert.equal(live.has('session-a'), false, 'live entry removed');
assert.equal(calls.detach, 1);
assert.equal(calls.unarchive, 0);
assert.ok(!(await fsp.access(path.join(sessionsProject, 'session-a')).then(() => true, () => false)));
const trashDir = path.join(home, 'trash', 'sessions', 'session-a');
assert.ok(await fsp.access(trashDir).then(() => true, () => false));
assert.ok(!(await fsp.access(path.join(trashDir, 'session.lock')).then(() => true, () => false)));
const manifest = JSON.parse(await fsp.readFile(path.join(home, 'trash', 'manifest.json'), 'utf8'));
assert.equal(manifest.entries['session-a'].displayTitle, '测试会话');
assert.equal(manifest.entries['session-a'].originalDir, path.join(sessionsProject, 'session-a'));

// 3) list
result = await service.list({});
assert.equal(result.ok, true);
assert.equal(result.items.length, 1);
assert.equal(result.items[0].sessionId, 'session-a');
assert.equal(result.items[0].displayTitle, '测试会话');
assert.ok(result.items[0].sizeBytes > 0);

// 4) restore: move back + re-attach
result = await service.restore({ sessionId: 'session-a' });
assert.equal(result.ok, true, `restore failed: ${JSON.stringify(result)}`);
assert.equal(result.attached, true, `attached: ${JSON.stringify(result)}`);
assert.equal(result.warning, null);
assert.equal(calls.attach, 1);
assert.ok(await fsp.access(path.join(sessionsProject, 'session-a', 'session.jsonl.zstd')).then(() => true, () => false));
assert.equal((await service.list({})).items.length, 0);

// 5) archived session trash path: unarchive called, restore recreates workspace when missing
await makeSession('session-arch', { archived: true, attached: false });
result = await service.trash({ sessionId: 'session-arch' });
assert.equal(result.ok, true, `arch trash failed: ${JSON.stringify(result)}`);
assert.equal(calls.unarchive, 1);
// no workspace owned it -> no detach call added
assert.equal(calls.detach, 1);
// restore with no recorded workspace path: files come back unattached
result = await service.restore({ sessionId: 'session-arch' });
assert.equal(result.ok, true);
assert.equal(result.attached, false);
assert.ok(result.warning, 'expected a warning when re-attach is impossible');

// 6) purge requires confirm, then really deletes (trash it again first —
// the restore above already removed it from the trash)
result = await service.trash({ sessionId: 'session-arch' });
assert.equal(result.ok, true, `re-trash failed: ${JSON.stringify(result)}`);
result = await service.purge({ sessionId: 'session-arch' });
assert.equal(result.ok, false);
assert.equal(result.reason, 'confirm-required');
result = await service.purge({ sessionId: 'session-arch', confirm: true });
assert.equal(result.ok, true, `purge failed: ${JSON.stringify(result)}`);
assert.ok(!(await fsp.access(path.join(home, 'trash', 'sessions', 'session-arch')).then(() => true, () => false)));
assert.equal((await service.list({})).items.length, 0);

// 7) purgeAll
await makeSession('session-c1');
await makeSession('session-c2');
await service.trash({ sessionId: 'session-c1' });
await service.trash({ sessionId: 'session-c2' });
result = await service.purgeAll({ confirm: true });
assert.equal(result.ok, true);
assert.equal(result.purged, 2);
assert.equal((await service.list({})).items.length, 0);

// 8) trash without any workspace membership keeps working
await makeSession('session-orphan', { attached: false });
result = await service.trash({ sessionId: 'session-orphan' });
assert.equal(result.ok, true, `orphan trash failed: ${JSON.stringify(result)}`);
result = await service.restore({ sessionId: 'session-orphan' });
assert.equal(result.ok, true);
assert.ok(result.warning, 'orphan restore warns about unknown workspace');

// 9) ghost row: no files, no registry references (e.g. purged earlier, the
// renderer row survived) -> success with alreadyGone, not a dead-end error
result = await service.trash({ sessionId: 'session-never-existed' });
assert.equal(result.ok, true, `ghost trash failed: ${JSON.stringify(result)}`);
assert.equal(result.alreadyGone, true);

// 10) ghost row still attached to a workspace: detach runs, then alreadyGone
await makeSession('session-ghost-attached', { attached: true });
await fsp.rm(path.join(sessionsProject, 'session-ghost-attached'), { recursive: true, force: true });
result = await service.trash({ sessionId: 'session-ghost-attached' });
assert.equal(result.ok, true, `attached ghost trash failed: ${JSON.stringify(result)}`);
assert.equal(result.alreadyGone, true);
// detaches so far: session-a (2), session-c2 during purgeAll prep (7), this one (10)
assert.equal(calls.detach, 3);
assert.equal(registry.entity.sessionIds.includes('session-ghost-attached'), false);

// 11) warm ghost: live entry exists but no directory -> alreadyGone + evicted
makeLive('session-warm-ghost');
result = await service.trash({ sessionId: 'session-warm-ghost' });
assert.equal(result.ok, true, `warm ghost trash failed: ${JSON.stringify(result)}`);
assert.equal(result.alreadyGone, true);
assert.equal(result.lingerUntilRestart, false);
assert.equal(live.has('session-warm-ghost'), false);

// 12) un-evictable live entry (no detach) -> success but lingerUntilRestart
await makeSession('session-stuck');
live.set('session-stuck', { session: { id: 'session-stuck' } });
result = await service.trash({ sessionId: 'session-stuck' });
assert.equal(result.ok, true, `stuck trash failed: ${JSON.stringify(result)}`);
assert.equal(result.alreadyGone, false);
assert.equal(result.lingerUntilRestart, true);

console.log('smoke: all assertions passed');
await fsp.rm(home, { recursive: true, force: true });
