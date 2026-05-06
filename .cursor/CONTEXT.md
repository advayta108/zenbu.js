This repo holds a javascript framework called zenbu.js

Its a javascript framework for building dynamic next.js applications. It has a dependency injection system for running services that can be HMR'd similar to how the react runtime works

It has a similar system to aspect oriented programming/emacs lisp with advice that lets you replace or wrap top level bindings

We have a database called kyju which is a document based database that syncs between data between processes via replicas, the replicas store in memory

You define schemas using zod. We have auto migration support that generates migration files and a journal. We also support collections to store large datasets in jsonl files

We have a type safe RPC lib called zenrpc that integrates with the services so that you can define methods on classes that are auto exposed via IPC

We allow external services to get loaded into the program and they get added to the DAG via a pipeline that:
- watches a json file
- imports the json file as a virtual module
- the module turns into a bunch of imports to the service file
- any code imported gets transformed by a node loader pipeline that:
  - compiles it with tsx
  - compiles it so it's hot reloadable (proxied imports, like vite, with dynohot)
  - compiles the code so u can wrap/replace functions

Then to render UI we use live vite dev servers to do their own compilation and bundling of react code, which just hmrs in production. 

Within the frontend code we have a microfrontend like architecture where u can render iframes on different sub domains to put them on different renderer processes

The user uses the package by creating a git sub module inside their repo with the framework code. Which means the user can modify the framework code like its theirs. Like shadcn but with git for updates

There is a core set of initialized services in the init package that applications can use without having to initialize themselves

There is an abstraction for using coding agents which uses zed's agent client protocol, which is just a json rpc protocol for communicating with an AI agent. We abstract creating the processes and creating a typescript sdk over it. We also integrate the package with kyju, so that the package writes state to kyju, so any consumer doesn't have to maintain the state associated with an agent

To build the application in a single executable you can use the build script. This includes bun, pnpm, and dugite (git) inside the bundle so that you can setup the framework on the users computer. On installation this toolchain is used to pull the user application code + framework code, run setup scripts using bun and pnpm installs, and then run the program by importing an entrypoint script that imports some code

In practice users will use preinstalled electron + bun/pnpm installs on the user computer so all it will take to run code is cloning the code to the computer and running it, as a browser just downloads code and runs it

We have a package create-zenbu-app which is used to quickly scaffold new applications, which is analogous to creat-next-app or create-react-app

