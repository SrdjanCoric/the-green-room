// Role-context schemas are part of the client/server wire contract, so they live in
// the dependency-free `shared/wire-contract` module the web client also imports. This
// file re-exports them for the workflow core, keeping every existing import path stable.
export {
  competencySchema,
  roleContextSchema,
  DEFAULT_ROLE_CONTEXT,
} from '../../../shared/wire-contract';
export type { Competency, RoleContext } from '../../../shared/wire-contract';
