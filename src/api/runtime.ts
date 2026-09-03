/**
 * Slice 1 API composition seam.
 *
 * Task 15.1 lands route/authentication/transport delegation only. The default
 * authenticates first and then fails closed with `service_unavailable`; it never
 * substitutes empty stores, service-role reads, or an allow-all permission check.
 *
 * As of task 26.2 the Authorization_Service exists (`@/authz/authorization-service`)
 * and `createApiAuthorizationGate` in `./authorization` is the adapter that plugs it
 * into these routes. It is still **not** composed here, and the reason is a privilege
 * gap rather than missing code: the service needs to read `user_permissions`, and
 * `authenticated` holds table grants on `ledger_entries` and `audit_events` only —
 * migration `20260101000009` issued none, deliberately. Composing a gate over a reader
 * that would fail with `42501` on every request would replace a truthful
 * `service_unavailable` with a misleading `500`. The composition root wires both once
 * the grants land; `configureSliceOneApi` is the entry point for it.
 */
import {
  ApiDependencyUnavailableError,
  createSliceOneRouteHandlers,
  type SliceOneRouteDeps,
  type SliceOneRouteHandlers,
} from './slice-one';
import { createSessionResolver } from './session';

const unavailable = (): never => {
  throw new ApiDependencyUnavailableError(
    'Slice 1 live adapters require table grants for the authenticated role before the ' +
      'task 26.2 Authorization_Service and the tenant-scoped stores can be composed',
  );
};

const defaultDeps: SliceOneRouteDeps = {
  sessions: createSessionResolver(),
  authorization: { require: async () => unavailable() },
  services: {
    startIngestion: async () => unavailable(),
    getControlTowerMetrics: async () => unavailable(),
    listExceptions: async () => unavailable(),
    getEvidenceChain: async () => unavailable(),
    runReconciliation: async () => unavailable(),
  },
};

let handlers: SliceOneRouteHandlers = createSliceOneRouteHandlers(defaultDeps);

/** Called by the future production composition root once the deferred seams exist. */
export function configureSliceOneApi(deps: SliceOneRouteDeps): void {
  handlers = createSliceOneRouteHandlers(deps);
}

export function sliceOneApi(): SliceOneRouteHandlers {
  return handlers;
}
