# Diff Speed — a byte-exact makefun-diff, at speed

[![bounty](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/fishit1070/diff-speed-01/rank.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/fishit1070/diff-speed-01/reward.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)

## What it is

An entry for the make.fun **Diff Speed** bounty: a `solve.js` whose
`run(input)` returns exactly the patch that the reference
`makefun-diff` 1.0.0 implementation returns — byte for byte, on every
input — while spending far less CPU doing it. One wrong byte scores
below every correct entry, so correctness is the hard constraint and
speed is what is left once correctness is total.

## How it works

The reference implementation spends most of its time in the Myers
edit-graph search, allocating small objects at nearly every step.
This entry computes the identical search with none of that traffic:

1. **Line interning.** Both texts are split on `\n` only (the format's
   rule) and every distinct line is mapped to a small integer id, so
   the search compares integers, never strings.
2. **Integer Myers search.** The greedy Myers algorithm runs on
   typed arrays with the reference's exact tie-breaking (deletion
   wins the `>=` comparison), the same sentinel handling for dead
   candidates, maximal snakes, and first-arrival path selection —
   the same decisions, in the same order, with zero per-step
   allocation. A 16-bit trace serves ordinary inputs; a 32-bit
   fallback covers the largest edit distances.
3. **Common prefix/suffix** are preserved exactly as the reference
   keeps them, and the patch text is assembled without intermediate
   slicing: the `makefun-diff/1` header, hunks with at most 3 lines
   of context, runs of 6 or fewer kept lines merged into one hunk,
   deletions before insertions, and the `%` marker line for a final
   line without a newline.

## Verification

- The kit's practice set passes 4/4.
- A fuzz harness comparing this `solve.js` against the reference
  implementation byte-for-byte over 9,192 generated cases (including
  forced runs down the 32-bit fallback path) found **0 mismatches**.
- Two consecutive runs over the practice set produce byte-identical
  output.
- On the machine this was built on, the trimmed-mean CPU per run
  measured ≈1.04M µs against ≈1.71M µs for the reference baseline
  measured the same way (≈1.65× gross). The grader's own control-run
  adjustment decides the official number.

## Layout

- `main.ts` — the kit entrypoint; grades `solve.js` and writes the
  dossier.
- `solve.js` — the whole implementation (ES module, no dependencies).
- `package.json` — `{ "type": "module" }`.
