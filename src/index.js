// Host half: the sessionTrash service. Moves session directories into ~/.dsh/trash
// and back; workspace bookkeeping stays inside the workspaceRegistry APIs, the
// registry's persisted state file is only ever read, never written.
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export const name = 'sessionTrash';
export const inject = ['workspaceRegistry', 'sessions'];

const LOCK_BASENAME = 'session.lock';

// Read lazily so tests can point DSH_HOME at a temp directory after import.
function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  return fromEnv && fromEnv.trim() !== '' ? path.resolve(fromEnv) : path.join(os.homedir(), '.dsh');
}
const sessionsRoot = () => path.join(dshHome(), 'sessions');
const trashRoot = () => path.join(dshHome(), 'trash');
const trashSessions = () => path.join(trashRoot(), 'sessions');
const manifestPath = () => path.join(trashRoot(), 'manifest.json');
const registryStatePath = () => path.join(dshHome(), 'storages', 'workspace.json');

async function pathExists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}
async function isDirectory(p) {
  try { return (await fsp.stat(p)).isDirectory(); } catch { return false; }
}
async function dirSize(root) {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else { try { total += (await fsp.stat(p)).size; } catch { /* unreadable entry counts as 0 */ } }
    }
  }
  return total;
}

async function readManifest() {
  try {
    const data = JSON.parse(await fsp.readFile(manifestPath(), 'utf8'));
    if (data && typeof data === 'object' && data.entries && typeof data.entries === 'object' && !Array.isArray(data.entries)) {
      return { version: 1, entries: data.entries };
    }
  } catch { /* missing or corrupt manifest starts fresh */ }
  return { version: 1, entries: {} };
}

async function writeManifest(manifest) {
  await fsp.mkdir(trashRoot(), { recursive: true });
  const tmp = `${manifestPath()}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, manifestPath());
}

async function findSessionDir(sessionId) {
  let names;
  try {
    names = await fsp.readdir(sessionsRoot());
  } catch (error) {
    if (error?.code === 'ENOENT') return null; // no sessions root at all: nothing to find
    throw error; // unreadable root is an IO problem, not "not found"
  }
  for (const projectKey of names) {
    if (projectKey !== '_no-cwd' && !projectKey.startsWith('--')) continue;
    const dir = path.join(sessionsRoot(), projectKey, sessionId);
    if (await isDirectory(dir)) return { dir, projectKey };
  }
  return null;
}

// Best-effort display title for sessions the client could not name (untitled
// rows): the aggregate projection cache keeps AI/user-set titles per session.
async function projcacheTitle(sessionId) {
  try {
    const data = JSON.parse(await fsp.readFile(path.join(dshHome(), 'storages', 'session_projcache.json'), 'utf8'));
    const rows = data?.tables?.sessions?.[sessionId]?.rows;
    const title = rows?.title?.val;
    return typeof title === 'string' && title.trim() !== '' ? title : null;
  } catch {
    return null;
  }
}

// Registry snapshot is read-only: it only decides which registry APIs to call;
// every state change goes through the registry's own write chain.
async function readRegistryState() {
  try {
    const data = JSON.parse(await fsp.readFile(registryStatePath(), 'utf8'));
    const global = data?.global ?? {};
    const tables = data?.tables?.workspaces ?? {};
    return {
      archived: new Set(Array.isArray(global.archivedSessionIds) ? global.archivedSessionIds : []),
      pinned: new Set(Array.isArray(global.pinnedSessionIds) ? global.pinnedSessionIds : []),
      workspaces: Object.entries(tables).map(([id, ws]) => ({
        id,
        path: typeof ws?.path === 'string' ? ws.path : null,
        title: typeof ws?.title === 'string' ? ws.title : null,
        sessionIds: Array.isArray(ws?.sessionIds) ? ws.sessionIds : [],
      })),
    };
  } catch {
    return { archived: new Set(), pinned: new Set(), workspaces: [] };
  }
}

function registryEntities(registry) {
  try {
    const listed = typeof registry?.list === 'function' ? registry.list() : [];
    return Array.isArray(listed) ? listed : [...listed];
  } catch {
    return [];
  }
}

function fail(reason, message = null) {
  return { ok: false, reason, message };
}

// A session opened during this sidecar's lifetime stays in the sessions
// service's live set, which pins it in the query index (and thus in
// session/list) even after its files are trashed. Detaching it from the live
// set (an internal, feature-detected path) lets the next index sync drop the
// row so a UI reload clears it; when the internals do not match we degrade to
// "the row lingers until the app restarts".
function makeLiveSetHelper(sessions) {
  const isLive = (sessionId) => {
    try { return typeof sessions?.get === 'function' && sessions.get(sessionId) !== undefined; }
    catch { return false; }
  };
  const evict = (sessionId) => {
    if (!isLive(sessionId)) return true;
    try {
      const entry = typeof sessions?.store?.get === 'function' ? sessions.store.get(sessionId) : undefined;
      if (entry && typeof entry.detach === 'function') entry.detach();
    } catch { /* best effort */ }
    return !isLive(sessionId);
  };
  return { isLive, evict };
}

export function apply(ctx) {
  const registry = ctx.get('workspaceRegistry');
  const sessions = ctx.get('sessions');
  const liveSet = makeLiveSetHelper(sessions);
  const inTurn = new Set();
  let queue = Promise.resolve();
  const serialized = (fn) => {
    const run = () => fn();
    const next = queue.then(run, run);
    queue = next.then(() => {}, () => {});
    return next;
  };

  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id;
    if (typeof sessionId !== 'string' || sessionId === '') return;
    if (event?.type === 'turn/start') inTurn.add(sessionId);
    else if (event?.type === 'turn/end') inTurn.delete(sessionId);
  }, { global: true });

  const service = {
    async list() {
      const manifest = await readManifest();
      let changed = false;
      const items = [];
      for (const [sessionId, entry] of Object.entries(manifest.entries)) {
        const dir = path.join(trashSessions(), String(entry?.dirName ?? sessionId));
        if (!(await isDirectory(dir))) {
          delete manifest.entries[sessionId];
          changed = true;
          continue;
        }
        items.push({
          sessionId,
          dirName: String(entry.dirName),
          originalDir: String(entry.originalDir ?? ''),
          projectKey: String(entry.projectKey ?? ''),
          workspacePath: entry.workspacePath ?? null,
          workspaceTitle: entry.workspaceTitle ?? null,
          displayTitle: entry.displayTitle ?? null,
          trashedAt: String(entry.trashedAt ?? ''),
          sizeBytes: Number.isFinite(entry.sizeBytes) ? entry.sizeBytes : 0,
        });
      }
      if (changed) { try { await writeManifest(manifest); } catch { /* self-heal write is best effort */ } }
      items.sort((a, b) => (a.trashedAt < b.trashedAt ? 1 : a.trashedAt > b.trashedAt ? -1 : 0));
      return { ok: true, reason: null, message: null, items };
    },

    async trash(request) {
      return serialized(async () => {
        const sessionId = String(request?.sessionId ?? '');
        if (sessionId === '') return fail('bad-request', 'sessionId is required');
        if (inTurn.has(sessionId)) return fail('busy', 'session is running; stop it before trashing');

        const state = await readRegistryState();

        // Registry hygiene first, ordered so re-attach side effects cannot
        // resurrect the row: unpin, then unarchive (it clears the archived flag;
        // unarchive may also re-attach), then detach wherever the session is now
        // listed. This also cleans up rows whose files are already gone (ghosts).
        if (state.pinned.has(sessionId)) {
          try { await registry?.unpinSession?.(sessionId); } catch { /* best effort */ }
        }
        if (state.archived.has(sessionId)) {
          try { await registry?.unarchiveSession?.(sessionId); } catch { /* best effort */ }
        }
        let detached = false;
        let detachError = null;
        let workspacePath = null;
        let workspaceTitle = null;
        for (const entity of registryEntities(registry)) {
          let ids;
          try { ids = entity.sessionIds; } catch { continue; }
          if (!Array.isArray(ids) || !ids.includes(sessionId)) continue;
          try {
            workspacePath = entity.path;
            workspaceTitle = entity.title;
          } catch { /* title/path are cosmetic */ }
          try { await entity.detachSession(sessionId); detached = true; }
          catch (error) { detachError = error; }
          break;
        }
        if (workspacePath !== null && !detached) {
          return fail('detach-failed', `registry detach failed: ${String(detachError?.message ?? detachError ?? 'unknown')}`);
        }

        let found;
        try { found = await findSessionDir(sessionId); }
        catch (error) { return fail('io-error', `sessions root unreadable: ${String(error?.message ?? error)}`); }

        // Ghost row: the sidebar entry survived (session lists have no removal
        // event) while the files are already gone (purged, or removed outside).
        // The registry is clean now — detach the live entry if any and report
        // success so the client can offer a UI reload instead of a dead-end error.
        if (!found) {
          const lingerUntilRestart = !liveSet.evict(sessionId);
          return { ok: true, reason: null, message: null, alreadyGone: true, lingerUntilRestart, workspacePath, displayTitle: null };
        }

        const targetName = (await isDirectory(path.join(trashSessions(), sessionId)))
          ? `${sessionId}.${Date.now()}`
          : sessionId;
        const target = path.join(trashSessions(), targetName);
        try {
          await fsp.mkdir(trashSessions(), { recursive: true });
          await fsp.rename(found.dir, target);
        } catch (error) {
          return fail('move-failed', `rename failed: ${String(error?.message ?? error)}`);
        }
        try { await fsp.unlink(path.join(target, LOCK_BASENAME)); } catch { /* stale lock removal is best effort */ }

        const manifest = await readManifest();
        let displayTitle = typeof request?.displayTitle === 'string' && request.displayTitle.trim() !== ''
          ? request.displayTitle
          : null;
        if (displayTitle === null) displayTitle = await projcacheTitle(sessionId);
        manifest.entries[sessionId] = {
          sessionId,
          dirName: targetName,
          originalDir: found.dir,
          projectKey: found.projectKey,
          workspacePath,
          workspaceTitle,
          displayTitle,
          trashedAt: new Date().toISOString(),
          sizeBytes: await dirSize(target),
        };
        await writeManifest(manifest);
        const lingerUntilRestart = !liveSet.evict(sessionId);
        return { ok: true, reason: null, message: null, alreadyGone: false, lingerUntilRestart, workspacePath, displayTitle };
      });
    },

    async restore(request) {
      return serialized(async () => {
        const sessionId = String(request?.sessionId ?? '');
        if (sessionId === '') return fail('bad-request', 'sessionId is required');
        const manifest = await readManifest();
        const entry = manifest.entries[sessionId];
        if (!entry) return fail('not-found', 'session is not in the trash');
        const from = path.join(trashSessions(), String(entry.dirName ?? sessionId));
        if (!(await isDirectory(from))) {
          delete manifest.entries[sessionId];
          await writeManifest(manifest);
          return fail('not-found', 'trashed directory is missing');
        }
        const to = String(entry.originalDir ?? '');
        if (to === '' || !to.startsWith(sessionsRoot() + path.sep)) {
          return fail('bad-request', 'recorded original directory is invalid');
        }
        if (await pathExists(to)) {
          // A live session's background write can recreate the directory after
          // the trash rename; set the stale leftover aside instead of failing.
          try {
            await fsp.rmdir(to);
          } catch {
            try {
              await fsp.mkdir(trashSessions(), { recursive: true });
              await fsp.rename(to, path.join(trashSessions(), `${sessionId}.stale.${Date.now()}`));
            } catch (error) {
              return fail('target-exists', `a directory already exists at the original location: ${String(error?.message ?? error)}`);
            }
          }
        }

        try {
          await fsp.mkdir(path.dirname(to), { recursive: true });
          await fsp.rename(from, to);
        } catch (error) {
          return fail('move-failed', `rename failed: ${String(error?.message ?? error)}`);
        }
        delete manifest.entries[sessionId];
        await writeManifest(manifest);

        let attached = false;
        let warning = null;
        const workspacePath = entry.workspacePath ?? null;
        if (typeof workspacePath === 'string' && workspacePath !== '') {
          try {
            let entity = null;
            try {
              const resolved = await registry?.resolveByPath?.(workspacePath);
              entity = resolved?.workspace ?? resolved ?? null;
            } catch { entity = null; }
            if (!entity || typeof entity.attachSession !== 'function') {
              const created = await registry?.create?.(workspacePath, entry.workspaceTitle ?? path.basename(workspacePath));
              entity = created?.workspace ?? created ?? entity;
            }
            if (entity && typeof entity.attachSession === 'function') {
              await entity.attachSession(sessionId);
              attached = true;
            } else {
              warning = 'workspace registry did not accept re-attachment';
            }
          } catch (error) {
            warning = `session files restored but re-attach failed: ${String(error?.message ?? error)}`;
          }
        } else {
          warning = 'original workspace unknown; session files restored but not attached';
        }
        return { ok: true, reason: null, message: null, attached, warning };
      });
    },

    async purge(request) {
      return serialized(async () => {
        if (request?.confirm !== true) return fail('confirm-required', 'purge requires confirm:true');
        const sessionId = String(request?.sessionId ?? '');
        if (sessionId === '') return fail('bad-request', 'sessionId is required');
        liveSet.evict(sessionId);
        const manifest = await readManifest();
        const entry = manifest.entries[sessionId];
        if (!entry) return fail('not-found', 'session is not in the trash');
        const dir = path.join(trashSessions(), String(entry.dirName ?? sessionId));
        try {
          await fsp.rm(dir, { recursive: true, force: true });
        } catch (error) {
          return fail('io-error', `delete failed: ${String(error?.message ?? error)}`);
        }
        delete manifest.entries[sessionId];
        await writeManifest(manifest);
        return { ok: true, reason: null, message: null };
      });
    },

    async purgeAll(request) {
      return serialized(async () => {
        if (request?.confirm !== true) return fail('confirm-required', 'purgeAll requires confirm:true');
        const manifest = await readManifest();
        let purged = 0;
        const nextEntries = {};
        for (const [sessionId, entry] of Object.entries(manifest.entries)) {
          liveSet.evict(sessionId);
          const dir = path.join(trashSessions(), String(entry?.dirName ?? sessionId));
          try {
            await fsp.rm(dir, { recursive: true, force: true });
            purged += 1;
          } catch { nextEntries[sessionId] = entry; }
        }
        if (purged > 0 || Object.keys(nextEntries).length !== Object.keys(manifest.entries).length) {
          manifest.entries = nextEntries;
          await writeManifest(manifest);
        }
        return { ok: true, reason: null, message: null, purged };
      });
    },

    async reveal() {
      const dir = trashRoot();
      await fsp.mkdir(dir, { recursive: true });
      try {
        if (process.platform === 'darwin') await execFileP('open', [dir]);
        else if (process.platform === 'linux') await execFileP('xdg-open', [dir]);
        else await execFileP('explorer', [dir]);
        return { ok: true, reason: null, message: null };
      } catch (error) {
        return fail('io-error', String(error?.message ?? error));
      }
    },
  };
  service.typertRemote = Object.freeze({ service, serviceKey: name, namespace: name });
  ctx.provide(name, service);
  ctx.effect(() => () => { inTurn.clear(); }, 'session-trash.state');
}
