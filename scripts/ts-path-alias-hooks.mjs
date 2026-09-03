/**
 * Module resolution hook that teaches plain `node` the one path alias this repo uses.
 *
 * `tsconfig.json` maps `@/*` to `./src/*` and every module under `src/` imports through
 * that alias (`@/config/env`, `@/calc/paise`, …). Vitest resolves it from
 * `vitest.config.ts`'s `resolve.alias`, and Next resolves it from `tsconfig.json`, but a
 * bare `node scripts/…` run has neither. Node 24 strips TypeScript types on its own, so
 * the alias is the *only* thing standing between `node` and running a script in
 * `scripts/` that imports the real `src/` modules.
 *
 * Two rewrites, both narrow:
 *
 *  - `@/x/y`  ->  `<repo>/src/x/y.ts`
 *  - `@/x/y/` ->  `<repo>/src/x/y/index.ts`
 *
 * Nothing else is touched: any specifier that is not alias-prefixed goes straight to the
 * default resolver, so package resolution, node: builtins and relative paths behave
 * exactly as they would without this hook.
 *
 * The `.ts` suffix is added because Node's ESM resolver needs a full specifier — there is
 * no extension search — while TypeScript's `bundler` moduleResolution deliberately omits
 * it. Adding it here keeps the source files idiomatic TypeScript.
 *
 * This file is `.mjs` rather than `.ts` on purpose: a resolution hook cannot depend on the
 * resolution it installs.
 */

// Imported rather than taken from the global scope: this file is plain JavaScript outside
// the TypeScript program, so the lint config gives it no browser or Node globals.
import { URL } from 'node:url';

const SRC = new URL('../src/', import.meta.url);

const ALIAS = '@/';

export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith(ALIAS)) {
    return nextResolve(specifier, context);
  }

  const subpath = specifier.slice(ALIAS.length);
  const target = subpath.endsWith('/')
    ? new URL(`${subpath}index.ts`, SRC)
    : new URL(`${subpath}.ts`, SRC);

  return nextResolve(target.href, context);
}
