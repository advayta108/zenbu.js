> [!WARNING]
> Zenbu is under active construction. It may break and is not ready for general usage.

<p align="center">
  <img src="./assets/logo.png" alt="Zenbu" width="100" />
</p>

<h1 align="center">Zenbu</h1>

<p align="center">
  <img alt="status: under construction" src="https://img.shields.io/badge/status-under_construction-orange"><br>
  A customizable app for using coding agents
</p>
<p align="center">
  <img src="./assets/screenshot.webp" width="640" style="background: transparent;" />
</p>


## What is Zenbu
Zenbu is a performant and minimal GUI for developing with coding agents

At its core is a system for modifying and extending the app. All features in the app are built on top of this core, allowing you to:
- edit any part of the app's original source code at runtime, and it will automatically update the app
- create composable and shareable modifications to the app (plugins)

Zenbu is currently under heavy construction. If you are interested in the project, you can download the code and start playing with the app by installing it, there is no development mode:
- https://www.zenbu.dev/download
- https://github.com/zenbu-labs/zenbu/releases

When you install the app, the source code of the app is downloaded and stored in `/.zenbu`. When the app is launched, there is a thin launcher (electron + custom node module loaders) that dynamically processes and run the raw source code.

## Development Tips

### CLI

The cli lets your agent easily control and introspect thea app. It also comes with tools to help manage and scaffold plugins.
~~~bash
zen                     # open a new window
zen --agent claude      # open with a specific agent
zen init my-plugin      # scaffold a new plugin
zen doctor              # re-run setup checks
zen link                # regenerate registry types after editing a service or schema
~~~

Inspect the local database:

~~~bash
zen kyju db root
zen kyju db collections
zen kyju db collection <id>
~~~

Generate a migration after changing a plugin schema:

~~~bash
zen kyju generate --name add_my_field
~~~

Call procedures exposed by plugins:

~~~bash
zen exec -e 'console.log(await rpc.cli.listAgents())'
zen exec -e 'const a = await rpc.cli.listAgents(); console.log(a.agents.length)'
zen exec ./my-automation.ts
~~~

Run this for the full list of commands:

~~~bash
zen --help
~~~

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
