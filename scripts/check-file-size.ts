/**
 * File-size gate. Big source files are where clinical invariants go to hide:
 * a 1000-line form component or export module accretes branches faster than a
 * reviewer can hold them, and this repo's whole doctrine is that the domain
 * rules must be READABLE, not merely present. So we cap growth.
 *
 * Two thresholds, named below:
 *   - over WARN_AT (600) -> a ⚠️ warning, never fails the build
 *   - over FAIL_AT (800) -> a ❌ hard failure
 *
 * The catch: five files already exceed 800 the day this gate lands, and a naive
 * hard limit would turn CI red on unrelated PRs. So the gate reads a committed
 * baseline (`scripts/size-limit-baseline.json`) recording each current offender
 * at its exact size. A baselined file is tolerated AT OR BELOW that size; it
 * FAILS if it grows past it ("refactor before adding more"). When an offender
 * is refactored to <= FAIL_AT it is no longer a legitimate baseline entry, and
 * the gate FAILS asking you to run `--update-baseline` — so the baseline can
 * only shrink deliberately and a file can never silently climb back over 800.
 *
 * Measures TRACKED source only (`git ls-files` over the app's own code), not
 * generated output, type stubs, or vendored files.
 *
 * Usage:
 *   npm run size-check                      # check only, never writes
 *   npm run size-check -- --update-baseline # rewrite baseline from current >800 set
 *
 * Org-shared configuration (all optional; defaults are the crea-map values that
 * this gate was hardened against):
 *   --baseline <path>    baseline JSON, relative to cwd
 *                        (default: scripts/size-limit-baseline.json)
 *   --include <rules>    comma-separated dir:ext[:ext] rules
 *                        (default: src/:.ts:.tsx,scripts/:.ts,prisma/:.ts)
 *   --warn-at <n>        warn threshold (default 600)
 *   --fail-at <n>        hard-fail threshold (default 800)
 *
 * Pure Node stdlib + tsx. No new dependency.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Read `--flag value` from argv; returns undefined when absent or flag-like. */
function argRaw(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i === -1) return undefined;
  const raw = process.argv[i + 1];
  if (raw === undefined || raw.startsWith('--')) return undefined;
  return raw;
}

function argInt(flag: string, fallback: number): number {
  const raw = argRaw(flag);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${flag} must be a positive integer, got "${raw}"`);
  }
  return n;
}

const WARN_AT = argInt('--warn-at', 600);
const FAIL_AT = argInt('--fail-at', 800);

if (WARN_AT >= FAIL_AT) {
  throw new Error(`--warn-at (${String(WARN_AT)}) must be below --fail-at (${String(FAIL_AT)})`);
}

/**
 * Which tracked files are measured. Filtering is done in JS rather than via
 * `git ls-files` pathspec globs on purpose: git pathspecs treat double-star and
 * single-star inconsistently across path separators (a doubled-star pathspec
 * rooted at "scripts" silently omits a file sitting directly in "scripts/",
 * e.g. this very script), which would leave blind spots. So we list ALL tracked
 * files and match here.
 *
 * A file is measured when it is under one of these top-level dirs AND ends in
 * one of these extensions:
 *   - src/       -> .ts, .tsx
 *   - scripts/   -> .ts
 *   - prisma/    -> .ts
 */
const DEFAULT_INCLUDE_RULES: readonly { readonly dir: string; readonly exts: readonly string[] }[] = [
  { dir: 'src/', exts: ['.ts', '.tsx'] },
  { dir: 'scripts/', exts: ['.ts'] },
  { dir: 'prisma/', exts: ['.ts'] },
];

/**
 * Parse `--include` as comma-separated `dir:ext[:ext...]` rules, e.g.
 * `src/:.ts:.tsx,scripts/:.ts`. A trailing slash on the dir is added when the
 * caller omits it, so `src` and `src/` behave identically.
 */
function parseIncludeRules(): readonly { readonly dir: string; readonly exts: readonly string[] }[] {
  const raw = argRaw('--include');
  if (raw === undefined) return DEFAULT_INCLUDE_RULES;
  const rules = raw
    .split(',')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const parts = chunk.split(':').map((p) => p.trim()).filter((p) => p.length > 0);
      const [dir, ...exts] = parts;
      if (dir === undefined || exts.length === 0) {
        throw new Error(`--include rule "${chunk}" must be "dir:.ext[:.ext]"`);
      }
      return { dir: dir.endsWith('/') ? dir : `${dir}/`, exts };
    });
  if (rules.length === 0) throw new Error('--include was given but parsed to zero rules');
  return rules;
}

const INCLUDE_RULES = parseIncludeRules();

function isIncluded(file: string): boolean {
  return INCLUDE_RULES.some(
    (rule) => file.startsWith(rule.dir) && rule.exts.some((ext) => file.endsWith(ext)),
  );
}

/**
 * Excluded even when a glob would catch them: type stubs, the generated Prisma
 * client (should never be tracked, but belt-and-suspenders), Next build output,
 * deps, and snapshot/fixture dirs whose length is data, not authored code.
 */
const EXCLUDE_PATTERNS: readonly RegExp[] = [
  /\.d\.ts$/,
  /(^|\/)node_modules\//,
  /(^|\/)\.next\//,
  /(^|\/)generated\//,
  /(^|\/)prisma\/client\//,
  /(^|\/)__snapshots__\//,
  /(^|\/)__fixtures__\//,
  /(^|\/)fixtures\//,
];

interface Baseline {
  readonly _comment?: string;
  readonly warnAt?: number;
  readonly failAt?: number;
  files: Record<string, number>;
}

/**
 * The repo under measurement is the CHECKED-OUT CALLER, not wherever this shared
 * script happens to live. Anchoring on cwd (rather than the script's own dir, as
 * the single-repo original did) is what lets one vendored copy serve every repo.
 */
const repoRoot = process.cwd();
const BASELINE_PATH = resolve(repoRoot, argRaw('--baseline') ?? join('scripts', 'size-limit-baseline.json'));

function loadBaseline(): Baseline {
  try {
    const raw = readFileSync(BASELINE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Baseline>;
    return {
      _comment: parsed._comment,
      warnAt: parsed.warnAt,
      failAt: parsed.failAt,
      files: parsed.files ?? {},
    };
  } catch {
    return { files: {} };
  }
}

/** Tracked files under the included dirs/exts, minus the exclusions. */
function listTrackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((file) => isIncluded(file))
    .filter((file) => !EXCLUDE_PATTERNS.some((re) => re.test(file)))
    .sort();
}

/** Physical line count, matching `wc -l` semantics (count of newline chars). */
function countLines(relPath: string): number {
  const buf = readFileSync(join(repoRoot, relPath));
  let lines = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) lines++;
  }
  return lines;
}

function updateBaseline(sizes: Map<string, number>): void {
  const files: Record<string, number> = {};
  for (const file of [...sizes.keys()].sort()) {
    const n = sizes.get(file)!;
    if (n > FAIL_AT) files[file] = n;
  }
  const existing = loadBaseline();
  const next: Baseline = {
    _comment: existing._comment,
    warnAt: WARN_AT,
    failAt: FAIL_AT,
    files,
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
  const n = Object.keys(files).length;
  console.log(
    `✅ Baseline rewritten: ${n} file${n === 1 ? '' : 's'} over ${FAIL_AT} lines recorded in ${BASELINE_PATH}`,
  );
}

function main(): void {
  const args = process.argv.slice(2);
  const updating = args.includes('--update-baseline');

  const files = listTrackedFiles();
  const sizes = new Map<string, number>();
  for (const file of files) sizes.set(file, countLines(file));

  if (updating) {
    updateBaseline(sizes);
    return;
  }

  const baseline = loadBaseline();

  const failures: string[] = [];
  const warnings: string[] = [];
  const suppressed: string[] = []; // baselined & within limit — reported, never fails

  for (const file of files) {
    const size = sizes.get(file)!;
    const baselined = Object.prototype.hasOwnProperty.call(baseline.files, file);
    const cap = baseline.files[file];

    if (size > FAIL_AT) {
      if (!baselined) {
        failures.push(
          `${file} — ${size} lines (over ${FAIL_AT}). New file over the hard limit. Split it, or if this is a deliberate, reviewed exception run \`npm run size-check -- --update-baseline\`.`,
        );
      } else if (size > cap) {
        failures.push(
          `${file} — grew from ${cap} to ${size} lines — refactor before adding more (baselined at ${cap}, must not grow).`,
        );
      } else {
        suppressed.push(`${file} — ${size} lines (baselined at ${cap}, over ${FAIL_AT} — grandfathered, not growing)`);
      }
    } else {
      // At or below FAIL_AT.
      if (baselined) {
        // A baselined file that dropped to <= FAIL_AT is no longer a valid
        // exception. Force a deliberate baseline shrink so it can't climb back.
        failures.push(
          `${file} — now ${size} lines (<= ${FAIL_AT}), no longer needs a baseline exception. Run \`npm run size-check -- --update-baseline\` to drop it (the baseline may only shrink deliberately).`,
        );
      } else if (size > WARN_AT) {
        warnings.push(`${file} — ${size} lines (over ${WARN_AT}, approaching the ${FAIL_AT} hard limit)`);
      }
    }
  }

  const inCI = process.env.GITHUB_ACTIONS === 'true';

  if (warnings.length > 0) {
    console.log(`\n⚠️  WARN (over ${WARN_AT} lines) — ${warnings.length}:`);
    for (const w of warnings) {
      console.log(`   ⚠️  ${w}`);
      if (inCI) {
        const [file] = w.split(' — ');
        console.log(`::warning file=${file}::${w}`);
      }
    }
  }

  if (suppressed.length > 0) {
    console.log(`\n🏳️  Grandfathered (baselined, over ${FAIL_AT}, not growing) — ${suppressed.length}:`);
    for (const s of suppressed) console.log(`   🏳️  ${s}`);
  }

  if (failures.length > 0) {
    console.log(`\n❌ FAIL (over ${FAIL_AT} lines) — ${failures.length}:`);
    for (const f of failures) {
      console.log(`   ❌ ${f}`);
      if (inCI) {
        const [file] = f.split(' — ');
        console.log(`::error file=${file}::${f}`);
      }
    }
  }

  console.log(
    `\nSummary: ${files.length} files checked · ${failures.length} fail · ${warnings.length} warn · ${suppressed.length} grandfathered.`,
  );

  if (failures.length > 0) {
    console.log(`\nBuild fails: ${failures.length} file-size violation${failures.length === 1 ? '' : 's'} above.`);
    process.exit(1);
  }
  console.log('✅ File-size gate passed.');
}

main();
