/**
 * The FinanceOS_API's adapter over the Authorization_Service (task 26.2).
 *
 * `src/api/slice-one.ts` calls an {@link ApiAuthorizationGate} between resolving the
 * session and delegating to any service, so this adapter is where Requirement 14.6's
 * "before the action reads or changes any Tenant financial data" is realised on the
 * request path. It holds no policy of its own: it translates the route's stated
 * requirement into a service call and the service's denial into the transport's
 * `403 permission_denied`.
 *
 * The translation is one-way and lossy on purpose. {@link PermissionDeniedError}
 * carries the required Permission and the action type; {@link ApiPermissionDeniedError}
 * carries only the required Permission, because the action type is Requirement 14.9's
 * Audit_Event field, not something a denied caller is owed. Nothing else is translated:
 * an `AuthorizationScopeError` — an unscoped session, or a route naming a Permission
 * that is not one of the six — propagates and surfaces as `500 internal_error`, since
 * it is a defect in the caller rather than a fact about the User.
 *
 * The direction of the dependency is deliberate: `src/authz` imports nothing from
 * `src/api`. The service does not know what a `Response` is, which is what lets it be
 * called from the internal tool endpoint and from a background path on the same terms.
 */

import {
  PermissionDeniedError,
  type AuthorizationService,
} from '@/authz/authorization-service';

import { ApiPermissionDeniedError, type ApiAuthorizationGate } from './slice-one';

/**
 * Adapts an {@link AuthorizationService} to the route funnel's gate.
 *
 * An array requirement is any-of, matching design.md's route table — `POST
 * /ingestion/runs` requires `manage_credentials` **or** `run_agents`. A single
 * Permission goes through `require` rather than a one-element `requireAny` so the
 * denial records the Permission label itself rather than a one-member list.
 */
export function createApiAuthorizationGate(
  service: AuthorizationService,
): ApiAuthorizationGate {
  return {
    async require(session, required, action) {
      try {
        if (typeof required === 'string') {
          await service.require(session, required, action);
        } else {
          await service.requireAny(session, required, action);
        }
      } catch (error) {
        if (error instanceof PermissionDeniedError) {
          throw new ApiPermissionDeniedError(error.required);
        }
        throw error;
      }
    },
  };
}
