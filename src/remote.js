// Wire contract for the sessionTrash remote namespace. Bundled zod only, no DSH code.
import { z } from 'zod';

const sessionId = z.string().min(1).max(512);
const nullableString = z.string().nullable();

function envelope(extra = {}) {
  return z.object({ ok: z.boolean(), reason: z.string().nullable(), message: z.string().nullable(), ...extra });
}

export const ListRequestSchema = z.object({});
export const ListResultSchema = envelope({
  items: z.array(z.object({
    sessionId,
    dirName: z.string().min(1),
    originalDir: z.string().min(1),
    projectKey: z.string(),
    workspacePath: nullableString,
    workspaceTitle: nullableString,
    displayTitle: nullableString,
    trashedAt: z.string(),
    sizeBytes: z.number(),
  })),
});

export const TrashRequestSchema = z.object({
  sessionId,
  displayTitle: z.string().max(512).nullable().optional(),
});
// alreadyGone: the sidebar row is a leftover of an already-deleted session
// (renderer session lists have no removal event); registry was cleaned and the
// client should offer a UI reload instead of a dead-end error.
// lingerUntilRestart: the session was live in the host's session set and could
// not be evicted, so the sidebar row only clears after an app restart.
export const TrashResultSchema = envelope({
  workspacePath: nullableString,
  displayTitle: nullableString,
  alreadyGone: z.boolean().optional(),
  lingerUntilRestart: z.boolean().optional(),
});

export const RestoreRequestSchema = z.object({ sessionId });
export const RestoreResultSchema = envelope({ attached: z.boolean(), warning: nullableString });

export const PurgeRequestSchema = z.object({ sessionId, confirm: z.boolean() });
export const PurgeResultSchema = envelope();

export const PurgeAllRequestSchema = z.object({ confirm: z.boolean() });
export const PurgeAllResultSchema = envelope({ purged: z.number() });

export const RevealRequestSchema = z.object({});
export const RevealResultSchema = envelope();

const PACKAGE = 'dsh-plugin-session-trash';

function call(method, requestSchema, resultSchema) {
  return {
    id: `${PACKAGE}#sessionTrash/${method}`,
    service: 'sessionTrash',
    namespace: 'sessionTrash',
    method,
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: {
        mode: 'strict',
        typeSymbol: `${PACKAGE}#sessionTrash/${method}:request`,
        create: () => requestSchema,
      },
    }],
    result: {
      mode: 'strict',
      typeSymbol: `${PACKAGE}#sessionTrash/${method}:result`,
      create: () => resultSchema,
    },
  };
}

export const TYPERT_REMOTE = {
  package: PACKAGE,
  descriptors: [
    call('list', ListRequestSchema, ListResultSchema),
    call('trash', TrashRequestSchema, TrashResultSchema),
    call('restore', RestoreRequestSchema, RestoreResultSchema),
    call('purge', PurgeRequestSchema, PurgeResultSchema),
    call('purgeAll', PurgeAllRequestSchema, PurgeAllResultSchema),
    call('reveal', RevealRequestSchema, RevealResultSchema),
  ],
};
