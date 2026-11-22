# mend: one patch tool for every AI edit format

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats,
and `mend` reads all four to the one specification in `SPEC.md`:

- a unified diff (often with wrong line numbers),
- SEARCH/REPLACE blocks,
- the V4A patch format,
- text-editor tool calls as JSON.

It finds the lines each edit names at the first of three matching tiers (exact, trailing whitespace ignored,
indentation ignored), and writes every change or none, printing what it changed or why it failed.

## Run it

Node 22 and its standard library alone; nothing to install.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

The working directory is the root of the tree. `PATCH` is the patch file, or `-` (or absent) to read it from
standard input. `--format` is `auto` (the default, which detects the format), `unified`, `search-replace`,
`v4a` or `json`. `--check` does everything but write. `--strict` matches lines exactly.

Exit 0 prints one line per changed file (`A`, `D`, `M`, or `R old -> new` for a move) and `ok: <n> files`.
Exit 1 prints one `error: <code> <path>` line per failed edit and `failed: <k> of <n> edits`, and nothing is
written. Exit 2 prints one line for a usage, missing-patch, format or parse error.

## The files

- `main.ts`: the CLI.
- `runner.ts`: the kit's runner, kept as it is. In a trial it reads the checks from the env, runs
  `node main.ts` on each one in a fresh directory, and posts what it did.
- `check.ts`: the practice set on your own machine. The kit carries it at `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json

  It prints every check `main.ts` gets wrong, with what differed, and the practice score.
- `SPEC.md`: the specification. It decides everything.
- `LICENSE`: MIT.
