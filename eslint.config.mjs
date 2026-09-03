import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * CI stage 1: `tsc --noEmit` + ESLint, gates a merge.
 *
 * The money-type rules (no `number`-typed identifier whose name reads as money in
 * src/calc, src/config, src/ingestion, src/ledger, src/tools, src/agents, src/wire)
 * are the `MONEY_RULES`
 * block below, attached to `MONEY_DIRS`. They exist alongside `src/calc/paise.ts`:
 * money is `Paise = bigint` and `number` never holds a monetary value
 * (Requirement 15.1, 15.8).
 */

/** Identifier names that read as money. Matched case-insensitively. */
const MONEY_NAME = 'paise|amount|impact|balance|cash|fee|gst|shortfall|headroom';

/**
 * The directories where money lives. Every monetary path is in one of these.
 *
 * `src/ingestion` is here because ingestion is where retrieved money enters the system:
 * `razorpay_objects.amount_paise`, `fee_paise` and `gst_on_fee_paise` are projected there
 * with no rounding, truncation or unit scaling (Requirement 1.7). A `number`-typed
 * `amount` on that path would lose the guarantee at the point of entry, where nothing
 * downstream could recover it.
 *
 * `src/config` is here because `tenant_configuration` holds three paise columns —
 * `compliance_review_threshold_paise`, `safety_buffer_paise` and
 * `model_monthly_cap_paise` — that the Compliance, Cash and Model paths read as
 * thresholds. A `number`-typed threshold there would corrupt a comparison against a
 * `Paise` amount just as surely as one in `src/calc`.
 *
 * `src/policy` is here as of task 22.1. The Policy_Engine reads `proposals.impact_paise`
 * and Requirement 5.15 computes the risk score from "the absolute INR impact of the
 * Proposal" — so a `number`-typed impact on the gate path would decide what may execute
 * from a value that had already lost precision. The risk score itself is deliberately a
 * plain `number`: it is an integer 0..100 ordinal, not money, and the rule fires on
 * money-shaped names only.
 *
 * `src/action` is here as of task 23.1. The FinanceOS_Action_Service reads
 * `proposals.impact_paise` on the approval path and, from task 23.3, compares
 * `observed_paise` against the expected outcome with a 1-paisa tolerance (Requirement
 * 5.11) — a comparison that means nothing unless both sides are exact integer paise.
 * The directory was absent from this list only because it held no code until 23.1.
 *
 * `src/evidence` is here as of task 9.1. `evidence_chains.figure_paise` and
 * `evidence_chain_steps.result_paise` are the `paise` domain, and an Evidence_Chain is
 * what makes a figure replayable to the exact paisa (Requirement 12.8) — a `number` on
 * that path would defeat the one guarantee the chain exists to provide. The directory was
 * absent from this list only because it held no code until 9.1.
 */
const MONEY_DIRS = [
  'src/action/**/*.ts',
  'src/calc/**/*.ts',
  'src/config/**/*.ts',
  'src/evidence/**/*.ts',
  'src/ingestion/**/*.ts',
  'src/ledger/**/*.ts',
  'src/policy/**/*.ts',
  'src/tools/**/*.ts',
  'src/agents/**/*.ts',
  'src/wire/**/*.ts',
];

const MONEY_MESSAGE =
  'Monetary values are `Paise` (bigint), never `number`. Import `Paise` from src/calc/paise.ts (Requirement 15.1, 15.8).';

/**
 * Fires on the `number` keyword in the type annotation of any identifier,
 * parameter, or property signature whose name reads as money.
 */
const MONEY_RULES = [
  {
    selector: `Identifier[name=/${MONEY_NAME}/i] > TSTypeAnnotation > TSNumberKeyword`,
    message: MONEY_MESSAGE,
  },
  {
    selector: `TSPropertySignature[key.name=/${MONEY_NAME}/i] > TSTypeAnnotation > TSNumberKeyword`,
    message: MONEY_MESSAGE,
  },
  {
    selector: `PropertyDefinition[key.name=/${MONEY_NAME}/i] > TSTypeAnnotation > TSNumberKeyword`,
    message: MONEY_MESSAGE,
  },
];
export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'out/**',
      'coverage/**',
      'dist/**',
      'next-env.d.ts',
      '**/*.tsbuildinfo',
      // Supabase CLI scratch space: generated, gitignored, and outside the tsconfig program.
      'supabase/.temp/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    // The money-type discipline, scoped to the directories that touch money.
    files: MONEY_DIRS,
    rules: {
      'no-restricted-syntax': ['error', ...MONEY_RULES],
    },
  },
  {
    // Config files are not part of the app program.
    files: ['*.config.ts', '*.config.mts', '*.config.mjs'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    /**
     * Plain-JS Node scripts under `scripts/`. They run under `node` directly, outside the
     * TypeScript program, so the block above does not cover them and `no-undef` from
     * `js.configs.recommended` has no idea `process` exists.
     *
     * The Node globals are declared explicitly rather than pulled from the `globals`
     * package, so this stays a config change and not a new dependency. `no-undef` is left
     * ON: a genuine typo in a script should still fail CI stage 1, which is the whole
     * reason not to simply disable the rule for this directory.
     */
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        URL: 'readonly',
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
);
