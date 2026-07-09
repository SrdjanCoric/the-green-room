// The transcript-entry schema is part of the client/server wire contract, so it lives
// in the dependency-free `shared/wire-contract` module the web client also imports.
// This file re-exports it for the workflow core, keeping every existing import stable.
export { transcriptEntrySchema } from '../../../shared/wire-contract';
export type { TranscriptEntry } from '../../../shared/wire-contract';
