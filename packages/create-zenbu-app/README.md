# create-zenbu-app

Scaffold a new [Zenbu](https://github.com/zenbu-labs/zenbu.js) app.

```bash
pnpm create zenbu-app my-app
cd my-app
pnpm dev
```

## Interactive mode

Run with no arguments to be prompted for a project name and config options:

```bash
pnpm create zenbu-app
```

You'll be asked for:

- **Project name** — defaults to `my-zenbu-app` (just press enter to accept).
- **Use Tailwind CSS?** — defaults to `yes`.

Each prompt's default is selected when you press enter, so a default scaffold
is just `enter, enter, enter`.

## Flags

| Flag | Description |
|---|---|
| `--yes`, `-y` | Skip every prompt and take each option's default. With no project name, scaffolds into the current directory. |
| `--no-install` | Skip the post-copy `<pm> install` step. |

A few common invocations:

```bash
pnpm create zenbu-app                  # interactive, then scaffolds ./my-zenbu-app
pnpm create zenbu-app my-app           # interactive options, scaffolds ./my-app
pnpm create zenbu-app .                # interactive options, scaffolds into cwd
pnpm create zenbu-app --yes            # all defaults, scaffolds into cwd
pnpm create zenbu-app my-app --yes     # all defaults, scaffolds ./my-app
```

## Templates

The CLI ships full per-config copies of the project under `templates/<slug>/`
— there are no in-template conditionals. Today:

- `templates/tailwind/` — Tailwind CSS v4 wired up via `@tailwindcss/vite`.
- `templates/vanilla/` — plain CSS, no utility framework.

The selected slug is computed from the answered config options (Tailwind
contributes `tailwind`; the empty set falls back to `vanilla`).

## Package manager support

The detected invoking package manager is recorded in `zenbu.config.ts` and
used for the post-copy install. pnpm, npm, yarn, and bun are all supported,
but the bundled `.app` re-installs from the project's lockfile at first
launch — so currently the lockfile must be a pnpm one.
