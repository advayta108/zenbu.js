> [!WARNING]
> Zenbu is under active construction. It may break and is not ready for general usage.

<p align="center">
  <img src="./assets/logo.png" alt="Zenbu" width="100" />
</p>

<h1 align="center">Zenbu</h1>

<p align="center">
  <img alt="status: under construction" src="https://img.shields.io/badge/status-under_construction-orange"><br>
  The extensible coding agent GUI
</p>

<p align="center">
  <img src="./assets/screenshot.webp" width="640" style="background: transparent;" />
</p>
## Codebase pointers

Main app:

- [apps/zenbu](https://github.com/zenbu-labs/zenbu/tree/main/apps/zenbu)

Current plugin API reference:

- [packages/init](https://github.com/zenbu-labs/zenbu/tree/main/packages/init)

Local reactive database:

- [packages/kyju](https://github.com/zenbu-labs/zenbu/tree/main/packages/kyju)

Plugin RPC:

- [packages/zenrpc](https://github.com/zenbu-labs/zenbu/tree/main/packages/zenrpc)

## Plugins

Plugins are units of code that can modify Zenbu's behavior.

They are configured in:

~~~txt
~/.zenbu/config.jsonc
~~~

Example:

~~~jsonc
{
  "plugins": [
    "...your plugin paths here"
  ]
}
~~~

The plugin API is not stable yet. For now, use the core plugin as the reference:

- [packages/init](https://github.com/zenbu-labs/zenbu/tree/main/packages/init)

## Agents

Zenbu currently ships with support for codex, claude, cursor, opencode, and copilot.

Zenbu assumes you have already authenticated the agent through its own CLI.

Additional agents can be added from Zenbu Settings if they are [ACP compatible](https://agentclientprotocol.com/get-started/registry).

## CLI

The zen CLI is mainly for development and debugging.

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

## Resetting local state

If an agent, plugin, or update breaks your local app, either revert changes in:

~~~txt
~/.zenbu/plugins/zenbu
~~~

or delete:

~~~txt
~/.zenbu/
~~~

Zenbu will reinstall itself on the next launch.
