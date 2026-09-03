/**
 * Resolve the project's Python interpreter and forward every argument to it.
 *
 * The Python CI stages are npm scripts so that one command list covers both runtimes
 * (design.md's CI ordering names stages 2, 4, 7, 8 and 9 on the Python side). Invoking
 * a bare `python` from those scripts does not work: on this machine it resolves to the
 * system interpreter at `C:\Python314`, which has none of the dev toolchain, so
 * `npm run py:typecheck-lint` failed with "No module named mypy" while the identical
 * command through `.venv` passed. The interpreter, not the code, was the difference.
 *
 * Resolution order, first hit wins:
 *
 *   1. `$PYTHON` — an explicit override, for CI images that manage their own venv.
 *   2. `.venv/Scripts/python.exe` (Windows) or `.venv/bin/python` (POSIX) — the
 *      layout `python -m venv .venv` produces, which is what the repo's own setup
 *      instructions create.
 *   3. `$VIRTUAL_ENV` — an already-activated environment that is not `.venv`.
 *   4. `python3`, then `python` — from PATH, so a machine with no venv still runs.
 *
 * The venv is preferred over an activated environment on purpose: a developer who
 * activated an unrelated environment and forgot should still get the toolchain this
 * project pinned, rather than a confusing missing-module error.
 *
 * Usage: `node scripts/python.mjs -m pytest -q`
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const WINDOWS = process.platform === 'win32';

/** The interpreter path inside a venv root, per platform layout. */
function interpreterIn(venvRoot) {
  return WINDOWS
    ? join(venvRoot, 'Scripts', 'python.exe')
    : join(venvRoot, 'bin', 'python');
}

function resolveInterpreter() {
  const explicit = process.env.PYTHON;
  if (explicit !== undefined && explicit !== '') {
    return explicit;
  }

  const projectVenv = interpreterIn(join(REPO_ROOT, '.venv'));
  if (existsSync(projectVenv)) {
    return projectVenv;
  }

  const activated = process.env.VIRTUAL_ENV;
  if (activated !== undefined && activated !== '') {
    const candidate = interpreterIn(activated);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // No venv found. Fall back to PATH and let the toolchain report what is missing.
  return WINDOWS ? 'python' : 'python3';
}

const interpreter = resolveInterpreter();
const args = process.argv.slice(2);

const result = spawnSync(interpreter, args, {
  cwd: REPO_ROOT,
  stdio: 'inherit',
  // `shell: false` so an argument containing a space or a quote reaches Python as one
  // argument rather than being re-split by a shell.
  shell: false,
});

if (result.error !== undefined) {
  process.stderr.write(
    `could not run the Python interpreter at ${interpreter}: ${result.error.message}\n` +
      `Create the project environment with:\n` +
      `  python -m venv .venv\n` +
      `  ${WINDOWS ? '.\\.venv\\Scripts\\python.exe' : './.venv/bin/python'} -m pip install -e ".[dev]"\n` +
      `or set PYTHON to an interpreter that has the dev extra installed.\n`,
  );
  process.exit(1);
}

// Mirror the child's termination so a failing stage fails the npm script. A signalled
// child has a null status, which must not be reported as success.
process.exit(result.status ?? 1);
