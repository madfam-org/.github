/**
 * Byte gate (org-shared). A control byte inside a source file passes EVERY other
 * gate — Node runs it, tsc types it, the bundler packs it, tests stay green — and
 * can still take production down: on 2026-09-01 a literal NUL inside a string
 * (`'\0…'` used as an "impossible id") broke evaluation of the served chunk and
 * with it the hydration of ALL client islands, without a single console error
 * (crea-map PR #200 -> revert #201 -> re-land #202). The only prior signal was
 * `Bin` in `git diff --stat`.
 *
 * This gate makes that signal explicit: it FAILS if a tracked source file holds
 *   - raw control bytes (0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F, 0x7F) — tab, LF and CR
 *     are the only legitimate control characters in text;
 *   - a BOM (EF BB BF) at any position — leading it confuses tooling, mid-line it
 *     is an invisible character; if a test needs a BOM as DATA, write it as a
 *     backslash-uFEFF escape inside the string, visible and honest;
 *   - U+2028/U+2029 in code files — Unicode line separators, legal in JS and
 *     famous for breaking JS embedded in HTML/JSON.
 *
 * An "impossible" sentinel is written with impossible TEXT (`'::name:declared::'`),
 * never with bytes no editor renders.
 *
 * Measures ONLY tracked source (`git ls-files`, text extensions). Zero
 * dependencies: plain Node stdlib, no tsx, no install step.
 *
 * Usage:
 *   node scripts/check-source-bytes.mjs
 *   node scripts/check-source-bytes.mjs --scan path/to/file      # debug one file
 *   node scripts/check-source-bytes.mjs --text-exts .ts,.tsx,.md # override set
 *   node scripts/check-source-bytes.mjs --code-exts .ts,.tsx     # U+2028/9 scope
 *   node scripts/check-source-bytes.mjs --paths src/,scripts/    # limit to prefixes
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const DEFAULT_TEXT_EXTS = [
  '.ts', '.tsx', '.js', '.mjs', '.cjs',
  '.css', '.md', '.sql', '.json', '.yml', '.yaml', '.sh', '.prisma',
];
const DEFAULT_CODE_EXTS = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const LSEP = Buffer.from([0xe2, 0x80, 0xa8]); // U+2028
const PSEP = Buffer.from([0xe2, 0x80, 0xa9]); // U+2029

/** Read `--flag value` from argv, returning `fallback` when absent or empty. */
function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  const raw = process.argv[i + 1];
  if (raw === undefined || raw.startsWith('--')) return fallback;
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return parts.length > 0 ? parts : fallback;
}

function lineColOf(data, offset) {
  let line = 1;
  let last = -1;
  for (let i = 0; i < offset; i += 1) {
    if (data[i] === 0x0a) {
      line += 1;
      last = i;
    }
  }
  return `${String(line)}:${String(offset - last)}`;
}

function isRawControl(b) {
  // Allowed: 0x09 tab, 0x0A LF, 0x0D CR. Everything else below 0x20, plus DEL.
  return (b <= 0x08) || b === 0x0b || b === 0x0c || (b >= 0x0e && b <= 0x1f) || b === 0x7f;
}

function scan(file, data, codeExts) {
  const findings = [];
  for (let i = 0; i < data.length; i += 1) {
    const b = data[i];
    if (b !== undefined && isRawControl(b)) {
      findings.push({ file, what: `control byte 0x${b.toString(16).padStart(2, '0')}`, offset: i });
      break; // one per file is enough to act on; the fix is to open the file
    }
  }
  const bomAt = data.indexOf(BOM);
  if (bomAt !== -1) {
    findings.push({ file, what: 'BOM (EF BB BF) — write it as \\uFEFF if it is data', offset: bomAt });
  }
  if (codeExts.some((e) => file.endsWith(e))) {
    for (const [buf, name] of [[LSEP, 'U+2028'], [PSEP, 'U+2029']]) {
      const at = data.indexOf(buf);
      if (at !== -1) findings.push({ file, what: `Unicode separator ${name}`, offset: at });
    }
  }
  return findings;
}

function main() {
  const textExts = argValue('--text-exts', DEFAULT_TEXT_EXTS);
  const codeExts = argValue('--code-exts', DEFAULT_CODE_EXTS);
  const pathPrefixes = argValue('--paths', []);

  const scanArg = process.argv.indexOf('--scan');
  const scanOne = scanArg !== -1 ? process.argv[scanArg + 1] : undefined;

  const files =
    scanOne !== undefined && !scanOne.startsWith('--')
      ? [scanOne]
      : execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
          .split('\n')
          .map((f) => f.trim())
          .filter((f) => f.length > 0)
          .filter((f) => textExts.some((e) => f.endsWith(e)))
          .filter((f) => pathPrefixes.length === 0 || pathPrefixes.some((p) => f.startsWith(p)));

  const findings = [];
  for (const f of files) {
    findings.push(...scan(f, readFileSync(f), codeExts));
  }

  if (findings.length === 0) {
    console.log(`byte-check ✅ ${String(files.length)} files · no control bytes`);
    return;
  }
  console.error(`byte-check ❌ ${String(findings.length)} finding(s):`);
  for (const fnd of findings) {
    const pos = lineColOf(readFileSync(fnd.file), fnd.offset);
    console.error(`  ${fnd.file}:${pos} — ${fnd.what} (offset ${String(fnd.offset)})`);
    if (process.env.GITHUB_ACTIONS === 'true') {
      console.error(`::error file=${fnd.file}::${fnd.what} (offset ${String(fnd.offset)})`);
    }
  }
  console.error('An invisible byte in source passes tests and build and can still take prod down (see header).');
  process.exitCode = 1;
}

main();
