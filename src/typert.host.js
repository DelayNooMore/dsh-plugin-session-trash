// Authored strict reflection for the sessionTrash service, whale-pet pattern:
// invocations are shared with the client via ./remote.js; every typeSymbol gets
// a matching schemas entry.
import {
  TYPERT_REMOTE,
  ListRequestSchema, ListResultSchema,
  TrashRequestSchema, TrashResultSchema,
  RestoreRequestSchema, RestoreResultSchema,
  PurgeRequestSchema, PurgeResultSchema,
  PurgeAllRequestSchema, PurgeAllResultSchema,
  RevealRequestSchema, RevealResultSchema,
} from './remote.js';

const SCHEMAS = [
  ['sessionTrash/list:request', ListRequestSchema],
  ['sessionTrash/list:result', ListResultSchema],
  ['sessionTrash/trash:request', TrashRequestSchema],
  ['sessionTrash/trash:result', TrashResultSchema],
  ['sessionTrash/restore:request', RestoreRequestSchema],
  ['sessionTrash/restore:result', RestoreResultSchema],
  ['sessionTrash/purge:request', PurgeRequestSchema],
  ['sessionTrash/purge:result', PurgeResultSchema],
  ['sessionTrash/purgeAll:request', PurgeAllRequestSchema],
  ['sessionTrash/purgeAll:result', PurgeAllResultSchema],
  ['sessionTrash/reveal:request', RevealRequestSchema],
  ['sessionTrash/reveal:result', RevealResultSchema],
];

export const TYPERT = {
  package: 'dsh-plugin-session-trash',
  face: 'host',
  schemas: SCHEMAS.map(([schemaName, schema]) => ({ name: schemaName, create: () => schema })),
  invocations: TYPERT_REMOTE.descriptors,
  model: {
    services: [{
      key: 'sessionTrash',
      exportName: 'SessionTrashService',
      description: 'Recoverable session trash: list, trash, restore, purge sessions.',
      summary: 'Session trash service',
      tags: [],
      members: [
        { kind: 'method', name: 'list', signature: 'list(request: SessionTrashListRequest): Promise<SessionTrashListResult>' },
        { kind: 'method', name: 'trash', signature: 'trash(request: SessionTrashTrashRequest): Promise<SessionTrashTrashResult>' },
        { kind: 'method', name: 'restore', signature: 'restore(request: SessionTrashRestoreRequest): Promise<SessionTrashRestoreResult>' },
        { kind: 'method', name: 'purge', signature: 'purge(request: SessionTrashPurgeRequest): Promise<SessionTrashPurgeResult>' },
        { kind: 'method', name: 'purgeAll', signature: 'purgeAll(request: SessionTrashPurgeAllRequest): Promise<SessionTrashPurgeAllResult>' },
        { kind: 'method', name: 'reveal', signature: 'reveal(request: SessionTrashRevealRequest): Promise<SessionTrashRevealResult>' },
      ],
      types: [],
    }],
    events: [],
    objects: [],
  },
};
export default TYPERT;
