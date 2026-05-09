> [!WARNING]
> Zenbu is under active construction. It may break and is not ready for general usage.

<p align="center">
  <img src="./assets/logo.png" alt="Zenbu" width="100" />
</p>

<h1 align="center">Zenbu</h1>

<p align="center">
  <img alt="status: under construction" src="https://img.shields.io/badge/status-under_construction-orange"><br>
  The personal software app
</p>
<p align="center">
  <img src="./assets/screenshot.webp" width="640" style="background: transparent;" />
</p>


## What is Zenbu
Zenbu is an app to build and share customizable desktop apps

At its core is Zenbu.js, a JavaScript framework for building desktop apps. All apps written in Zenbu.js can be modified while they are running, made possible by a built in plugin system

Zenbu is currently under heavy construction. If you are interested in the project, you should join the discord - [invite link](https://discord.gg/t3jzHHfc6z)


## Quickstart

> [!IMPORTANT]
> Zenbu currently requires **pnpm 10+**. The scaffolded app's lockfile is pnpm; using npm or yarn will produce a non-portable install (the bundled .app re-installs from the pnpm lockfile at first launch). A future config knob will let you bundle a different package manager.

~~~bash
pnpm create zenbu-app my-app
cd my-app
pnpm install
pnpm dev
~~~

## CLI

The `zen` CLI ships as a `bin` of `@zenbujs/core` — every scaffolded app gets it automatically through `pnpm install`.

~~~bash
zen dev                              # run the local app with HMR
zen build:source                     # transform src/ into a portable seed
zen build:electron                   # bundle .app via electron-builder
zen build:electron -- --publish always
                                     # forward args to electron-builder
zen publish:source [init|push]       # sync the seed to a mirror github repo
zen link                              # regenerate registry types
~~~

## Distribution

Two complementary channels:

- **GitHub release of the .app** — driven by your own `electron-builder.json`. `zen build:electron -- --publish always` hands the build off to electron-builder's native publish flow.
- **Source mirror repo** — `zen publish:source` pushes the transformed seed to a github repo declared in `zenbu.build.ts#mirror.target`. Apps already in the field can `git pull` updates without a full re-download.

## Development Tips

### Resetting local state

If an agent, plugin, or update breaks your local app, either revert changes in:

~~~txt
~/.zenbu/plugins/zenbu
~~~

or delete:

~~~txt
~/.zenbu/
~~~

Zenbu will reinstall itself on the next launch.
