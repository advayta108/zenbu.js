> [!WARNING]
> Zenbu is in alpha

Zenbu.js is a JavaScript framework for building hackable software

### Get started in 5s

```
pnpx create-zenbu-app my-zenbu-app
cd my-zenbu-app
pnpm run dev
```

> **Try the demo:** [https://www.zenbu.dev/demo](https://www.zenbu.dev/demo)

### Why should you use this

1. Coding agents make it possible to generate software on demand for a specific use case. If apps was hackable, users could customization applications for a specific use case without starting from scratch. When you write an app in Zenbu your entire app is modifiable and extensible.

2. Giving users the ability to modify your app makes it possible to explore many more directions than you could yourself

3. Zenbu enforces an architecture to make your code extensible through low coupling and high cohesion. This makes it possible to make more complex applications without noticable complexity added to your codebase

### How does it work

Users can modify Zenbu apps in 2 ways:

#### Modifying the raw source code

When a Zenbu app is built for production, there is no TypeScript compilation or bundling step. The same source code you wrote in development will be downloaded by the user and stored in `~/.zenbu/<app-name>`. When the app launches, it discovers the app code, dynamically compiles it, and runs the JavaScript using Electrons node.js runtime.

All the source code in this directory is being watched for changes. When there is a change, the app will re-run affected code nearly instantly (also known as hot reloading). Hot reloading is implemented both in the main process and the renderer process.

The codebase stored inside `~/.zenbu/<app-name>` is tracked by git. This makes it possible for a user to edit the source code without losing changes when the application code gets updated. The git repo is linked to a remote repository owned by the developer, so updates are represented as running `git pull` on the users device.

#### Injecting plugins

Editing the raw source code of the application can be risky. If a user and the developer have conflicting edits, the user needs to spend time merging changes. This motivates plugins - a way to inject code into the application that can modify behavior without editing the raw source code.

Plugins run in the same process as the application code and get access to the same APIs. This means any feature written in the main app could be written as a plugin.

When you write an app in Zenbu you do not need to think about writing a plugin API. The framework APIs are designed so that your code is **default** extensible.

Plugins hot reload the same way application code hot reloads. This is because application code gets implemented as a plugin.

### Docs
