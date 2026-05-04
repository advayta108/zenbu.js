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
Zenbu is an app to build, share, and discover customizable desktop apps

At its core is Zenbu.js, a JavaScript framework for building desktop apps. All apps written in Zenbu.js can be modified while they are running, letting users customize and extend applications with their coding agents.



Zenbu is currently under heavy construction. If you are interested in the project, you should join the discord - [invite link](https://discord.gg/t3jzHHfc6z)


## Development Tips

### CLI

The cli lets your agent easily control and introspect the app. It also comes with tools to help manage and scaffold plugins.
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
