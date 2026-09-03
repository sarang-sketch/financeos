/**
 * Installs `./ts-path-alias-hooks.mjs` so a `node scripts/*.ts` run can import `@/…`.
 *
 * Use it as `node --import ./scripts/register-ts-path-alias.mjs scripts/<script>.ts`.
 * Registration has to happen in a separate `--import` module because hooks must be in
 * place before the entry point is loaded.
 */

import { register } from 'node:module';

register('./ts-path-alias-hooks.mjs', import.meta.url);
