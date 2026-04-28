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
Zenbu is a performant and minimal GUI for developing with coding agents.

At its core is a system for modifying and extending the app. All features in the app are built on top of this system, allowing you to:

* Edit any part of the app's original source code while it's running
* Create composable and shareable modifications to the app

Zenbu is currently under heavy construction. If you are interested in the project, you can start playing with the app by installing it:

* https://www.zenbu.dev/download

When you launch the app:

1. The raw source code is dynamically downloaded to your computer using `git clone` and stored inside `~/.zenbu/plugins/`
2. The source code is transformed using a small compiler to make the code more dynamic
3. The transformed source code is run by the Node.js runtime
4. The Node.js process serves a website at a port on localhost

You can use Zenbu through the built-in desktop app or directly in your browser.

Any changes made to the raw source code in `~/.zenbu/plugins` will immediately be reflected in the running application. This is made possible by a custom runtime that gives the app the capability to process updates without restarting any processes.

> If you are familiar with Electron, this means both the main process and renderer process can be hot-reloaded while in production.

Because any modifications you make to the core plugins have the risk of conflicting with future updates, you should use plugins to make merge-safe modifications. Plugins are modular blocks of code that can modify any behavior of the app. This is made possible by a collection of many undocumented APIs that are already being used to build the core. Plugins are able to:

- Replace or wrap the value of any top-level binding, such as a function or variable, at runtime
- Read and write to globally synchronized state
- Communicate with each other in a type-safe way
- Access the internal UI theming and component system
- Compose together
- Have their raw source code edited




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
