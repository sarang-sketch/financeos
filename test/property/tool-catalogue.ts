/**
 * The read-only Financial_Tool catalogue, discovered rather than listed, so
 * property P6 (task 9.3) covers every tool tasks 12.x add without anyone
 * remembering to add it here.
 *
 * ## The problem this module solves
 *
 * design.md's P6 generator input is `arbitraryTenantDataset`, "then **every
 * read-only tool in the catalogue** invoked over it". `src/tools/registry.ts`
 * (task 10.1) builds a catalogue from a list handed to `createToolRegistry`, and
 * **nothing hands it one yet**: there is no composition root, and the 17
 * read-only tools are tasks 12.1 through 12.6. A P6 that imported a hand-written
 * list of tools would be a P6 a tool author escapes by forgetting the list —
 * which is the one failure mode a property gate cannot have.
 *
 * So the catalogue is discovered from the filesystem: every `.ts` module under
 * the production roots is imported, every exported value that satisfies
 * {@link ErasedFinancialTool} is collected, and the collected set is passed
 * through the real {@link createToolRegistry}, audit and all. A tool is in P6's
 * scope because it *exists*, not because it was registered twice.
 *
 * ## The one thing a tool author still has to provide, and why
 *
 * P6 has to *invoke* each read-only tool over a generated dataset. A
 * `FinancialTool.execute` takes a `ToolContext` carrying a live `db` client and
 * an input conforming to its own schema, and **design.md states no way to drive
 * an arbitrary tool over a generated dataset**: nothing says how a generated
 * Tenant dataset reaches a tool's reads, and the argument values are the tool's
 * own business. That is a real gap, reported rather than invented around.
 *
 * The seam is therefore one export per tool module: a {@link P6ToolProbe} naming
 * the tool and returning the figures it presents over a given dataset, each with
 * its Evidence_Chain and the Source_Records the chain cites. It is small on
 * purpose — a probe states nothing P6 could have derived — and it cannot be
 * skipped: a registered `read_only` tool with no probe **fails P6**
 * ({@link missingProbes}), so the pressure lands on the tool author at the moment
 * the tool enters the catalogue rather than on whoever runs the property gate at
 * task 17.
 *
 * Task 10.2's contract harness will need a comparable per-tool seam (a valid
 * input sample, at least). If it defines one, this probe should be folded into
 * it rather than kept beside it; noted here rather than pre-empted, since 10.2 is
 * being written in parallel and owns `test/contract/**`.
 *
 * ## Discovery is deliberately blunt
 *
 * `readdir` + dynamic `import`, no cache, no glob plugin, no manifest. A module
 * that throws on import fails discovery loudly rather than being skipped, because
 * a tool that cannot be imported is a tool P6 would otherwise silently drop. The
 * specifier is rebuilt as an aliased path (`@/tools/...`) rather than a file URL
 * so the imported module's own `@/` imports resolve the same way they do in
 * production.
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EvidenceChain, SourceRef } from '@/evidence/chain-builder';
import {
  createToolRegistry,
  type CatalogueEntry,
  type ToolRegistry,
} from '@/tools/registry';
import { type ErasedFinancialTool, TOOL_TIMEOUT_MS } from '@/tools/tool';

import type { EvidenceTenantDataset } from './evidence-chain-generators';

/* -------------------------------------------------------------------------- */
/* The probe seam                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One monetary figure a tool presented, with everything P6 needs to check it.
 *
 * `records` is the replay seam: `evidence_chain_sources` stores `(type, id,
 * field)` and **no value**, so a replay cannot be given only a chain (task 9.2's
 * largest reported gap). A probe therefore hands back the records the chain
 * cites, `signed_amount` projections included.
 */
export interface ProbedFigure {
  /** Which figure of the tool's output this is, for a readable failure. */
  readonly label: string;
  /** Exactly what `ToolSuccess.evidence` carried. */
  readonly evidence: EvidenceChain;
  /** The cited Source_Records, in 9.2's `{ ref, fields }` shape. */
  readonly records: readonly {
    readonly ref: SourceRef;
    readonly fields: Readonly<Record<string, bigint>>;
  }[];
  /**
   * The `(record, field)` citations with their update timestamps, where the tool
   * has them. Absent means P6 reconstructs one citation per identifier from
   * `evidence.sources` and `evidence.as_of`, which is enough for the pagination
   * clauses but not for the stale indicator.
   */
  readonly citations?: readonly {
    readonly ref: SourceRef;
    readonly field: string;
    readonly record_updated_at: string;
  }[];
}

/**
 * A tool module's P6 seam. Exported under any name; discovery finds it by shape.
 *
 * `figuresFor` must present every monetary figure the tool returns over the given
 * dataset. A tool that presents none over some datasets returns `[]` for those,
 * which P6 tolerates — but a tool that returns `[]` for **every** dataset is
 * reported, since a read-only tool presenting no figure at all has nothing for
 * Requirement 12.8 to hold over.
 */
export interface P6ToolProbe {
  /** Must equal the registered tool name. Checked against the registry. */
  readonly tool: string;
  figuresFor(dataset: EvidenceTenantDataset): Promise<readonly ProbedFigure[]>;
}

/* -------------------------------------------------------------------------- */
/* Roots                                                                      */
/* -------------------------------------------------------------------------- */

/** One directory to scan, and how a file inside it becomes an import specifier. */
export interface CatalogueRoot {
  /** Absolute directory. Missing is not an error: a root may not exist yet. */
  readonly dir: string;
  /** `('foo/bar')` → the specifier that imports `<dir>/foo/bar.ts`. */
  specifier(relativeWithoutExtension: string): string;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Where a Financial_Tool can live.
 *
 * `src/tools` is where task 10.1 put the contract and the registry, and where
 * tasks 12.x will put the tools. `src/agents` is included because task 11.1 is
 * building `src/agents/reconciliation/**` and an Agent module could plausibly
 * declare a tool beside its algorithm; scanning it costs nothing and closes the
 * obvious escape. Neither task states a path — design.md names no file for any
 * tool — so the net is cast wider than the guess.
 */
export const PRODUCTION_ROOTS: readonly CatalogueRoot[] = [
  {
    dir: path.join(repoRoot, 'src', 'tools'),
    specifier: (relative) => `@/tools/${relative}`,
  },
  {
    dir: path.join(repoRoot, 'src', 'agents'),
    specifier: (relative) => `@/agents/${relative}`,
  },
];

/**
 * The specimen root: `test/property/fixtures`, holding one read-only tool that
 * exists solely to prove this machinery runs. See
 * `p6-evidence-chain-replay.property.test.ts` on why the mechanism is proven
 * against a specimen instead of being left dead until task 12.1.
 */
export const SPECIMEN_ROOT: CatalogueRoot = {
  dir: path.join(repoRoot, 'test', 'property', 'fixtures'),
  specifier: (relative) => `./fixtures/${relative}`,
};

/* -------------------------------------------------------------------------- */
/* Discovery                                                                  */
/* -------------------------------------------------------------------------- */

/** `.ts` modules under `dir`, recursively, excluding tests and declarations. */
async function moduleSpecifiers(root: CatalogueRoot): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(root.dir, { recursive: true, withFileTypes: true });
  } catch {
    // A root that does not exist yet contributes nothing. `src/agents` is empty
    // but for a `.gitkeep` today.
    return [];
  }
  const specifiers: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) {
      continue;
    }
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.d.ts')) {
      continue;
    }
    const absolute = path.join(entry.parentPath, entry.name);
    const relative = path
      .relative(root.dir, absolute)
      .replace(/\\/g, '/')
      .replace(/\.ts$/, '');
    specifiers.push(root.specifier(relative));
  }
  return specifiers.sort();
}

function isToolLike(value: unknown): value is ErasedFinancialTool {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['name'] === 'string' &&
    (candidate['mode'] === 'read_only' || candidate['mode'] === 'write_capable') &&
    typeof candidate['execute'] === 'function' &&
    typeof candidate['inputSchema'] === 'object' &&
    candidate['inputSchema'] !== null &&
    typeof candidate['outputSchema'] === 'object' &&
    candidate['outputSchema'] !== null &&
    candidate['timeoutMs'] === TOOL_TIMEOUT_MS
  );
}

function isProbeLike(value: unknown): value is P6ToolProbe {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate['tool'] === 'string' && typeof candidate['figuresFor'] === 'function';
}

/** What one scan found. */
export interface DiscoveredCatalogue {
  /** Every module specifier imported, in sorted order. */
  readonly modules: readonly string[];
  /** Every tool found, audited by the real registry. */
  readonly registry: ToolRegistry;
  /** `registry.byMode('read_only')`, which is what P6 iterates. */
  readonly readOnly: readonly CatalogueEntry[];
  /** Every P6 probe found, keyed by the tool name it names. */
  readonly probes: ReadonlyMap<string, P6ToolProbe>;
}

/**
 * Import every module under `roots` and build the catalogue from what they
 * export.
 *
 * Throws when a module cannot be imported, and (through
 * {@link createToolRegistry}) when a declaration fails the registration audit. A
 * tool that cannot be proven is not a tool P6 gets to skip.
 */
export async function discoverCatalogue(
  roots: readonly CatalogueRoot[],
): Promise<DiscoveredCatalogue> {
  const modules: string[] = [];
  const tools: ErasedFinancialTool[] = [];
  const probes = new Map<string, P6ToolProbe>();

  for (const root of roots) {
    for (const specifier of await moduleSpecifiers(root)) {
      modules.push(specifier);
      const imported: unknown = await import(specifier);
      if (typeof imported !== 'object' || imported === null) {
        continue;
      }
      for (const exported of Object.values(imported)) {
        if (isToolLike(exported)) {
          tools.push(exported);
        } else if (isProbeLike(exported)) {
          probes.set(exported.tool, exported);
        }
      }
    }
  }

  const registry = createToolRegistry(tools);
  return {
    modules,
    registry,
    readOnly: registry.byMode('read_only'),
    probes,
  };
}

/**
 * The read-only tools that have no P6 probe. Non-empty means P6 fails: a tool
 * presenting figures P6 cannot replay is exactly what Requirement 12.8 forbids
 * going unchecked.
 */
export function missingProbes(catalogue: DiscoveredCatalogue): readonly string[] {
  return catalogue.readOnly
    .map((entry) => entry.tool.name)
    .filter((name) => !catalogue.probes.has(name));
}

/** Probes naming a tool the catalogue does not hold, or holds as write-capable. */
export function strandedProbes(catalogue: DiscoveredCatalogue): readonly string[] {
  const readOnlyNames = new Set(catalogue.readOnly.map((entry) => entry.tool.name));
  return [...catalogue.probes.keys()].filter((name) => !readOnlyNames.has(name)).sort();
}
