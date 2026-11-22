# mend

One patch tool for every AI edit format.

`mend` is a command-line tool that applies AI-written edits to a tree of
text files. It reads all four formats models write — unified diffs (often
with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and
text-editor tool calls as JSON — to the one written specification in the
kit's `SPEC.md`, finds the lines an edit names even when the model drifted
their whitespace or indentation, and changes every file or none.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file, relative to the working directory (the root of
  the tree). When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`,
  `json`, or `auto` (the default, which detects it).
- `--check` does everything but write: same output and exit code, no file
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit `0` lists the changed files (`A`/`D`/`M`, `R old -> new` for moves)
and `ok: <n> files`. Exit `1` lists each failed edit and
`failed: <k> of <n> edits` (no file is written). Exit `2` reports a usage,
no-patch, format or parse error.

## Files

- `main.ts` — the CLI (Node 22, standard library only).
- `runner.ts` — the kit's trial runner (unchanged).

Built for the [$100 USDC bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
"Build mend, one patch tool for every AI edit format" on make.fun.

## License

MIT — see `LICENSE`.
