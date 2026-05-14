# create-desktop-app

Scaffold a new desktop app in seconds. macOS only (for now).

```bash
npx create-desktop-app My App --icon ./icon.png
```

This creates `/Applications/My App.app` (a customized Electron bundle) and
sources at `~/.zenbu/apps/my-app`. The app launches into Spotlight,
Launchpad, and the dock like any other native app.

`create-desktop-app` is a thin wrapper around
[`create-zenbu-app`](https://www.npmjs.com/package/create-zenbu-app); all
behavior lives there.

## Flags

| Flag | Description |
|------|-------------|
| `--icon <path>` | Path to a `.png` (square, 1024x1024 recommended) or `.icns` |
| `--electron-version <semver>` | Override the Electron version (default: latest in template's range) |
| `--no-install` | Defer `pm install` to first launch |
| `--force` | Overwrite an existing `/Applications/<Name>.app` and `~/.zenbu/apps/<slug>` |
| `--dry-run` | Print every step without writing |
| `--verbose` | Mirror the per-run log file to stdout |
| `--yes`, `-y` | Auto-confirm every prompt with the default |
