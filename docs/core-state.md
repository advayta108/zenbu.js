# Core State

Core DB sections store durable state and last-known facts, not process liveness.

Services may keep live resources in memory: Electron windows, sockets, Vite
servers, ports, child processes, subscriptions, and watchers. Those resources
are reconstructed on startup. If the process is killed, the database must still
be semantically true.

Use explicit names for persisted snapshots so callers do not confuse them with
live state:

- `lastKnownBounds` means the last bounds observed for a window, not proof that
  the window is currently open.
- `lastKnownViewRegistry` means the last view registry snapshot emitted by the
  running process, not proof that those dev servers or ports are still live.

Cleanup hooks are still useful for releasing resources and improving freshness,
but correctness must not depend on a graceful shutdown.
