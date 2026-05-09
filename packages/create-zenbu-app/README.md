# create-zenbu-app

Scaffold a new [Zenbu](https://github.com/zenbu-labs/zenbu.js) app.

```bash
pnpm create zenbu-app my-app
cd my-app
pnpm install
pnpm dev
```

Zenbu currently requires pnpm 10+. The bundled .app re-installs from the
pnpm lockfile at first launch, so the project's lockfile must be a pnpm one.
