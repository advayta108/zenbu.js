/**
 * Pause HMR
 *
 * This is currently WIP, on resume the changed modules need to get re-evaluated
 * for the world to be in a valid state
 */

const PAUSE_KEY = Symbol.for("dynohot.fileWatcher.pauseCounts");

function getPauseCounts(): Map<string, number> {
	const g = globalThis as Record<symbol, unknown>;
	let map = g[PAUSE_KEY] as Map<string, number> | undefined;
	if (!map) {
		map = new Map<string, number>();
		g[PAUSE_KEY] = map;
	}
	return map;
}

export function pauseWatcherPath(prefix: string): () => void {
	const pauseCounts = getPauseCounts();
	pauseCounts.set(prefix, (pauseCounts.get(prefix) ?? 0) + 1);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const counts = getPauseCounts();
		const current = counts.get(prefix) ?? 0;
		if (current <= 1) {
			counts.delete(prefix);
		} else {
			counts.set(prefix, current - 1);
		}
	};
}

/** @internal Called by the file watcher to skip firing while paused. */
export function isWatcherPathPaused(absolutePath: string): boolean {
	const pauseCounts = getPauseCounts();
	if (pauseCounts.size === 0) return false;
	for (const prefix of pauseCounts.keys()) {
		if (absolutePath === prefix || absolutePath.startsWith(prefix + "/")) {
			return true;
		}
	}
	return false;
}

/**
 * Registry of fs.watch-backed watchers that need to be `.close()`'d before
 * process exit. On macOS, `fs.watch` uses FSEvents.framework on a
 * background thread; if we `_exit(0)` (or skip shutdown hooks) while
 * watchers are still armed, FSEvents will try to dispatch events into a
 * dying V8 isolate → `napi_call_function` assertion → SIGABRT. Callers
 * (dynohot's FileWatcher, the kernel's zenbu-loader-hooks) register their
 * fs watchers here and the shell invokes `closeAllWatchers()` as part of
 * shutdown.
 */

const WATCHER_SET_KEY = Symbol.for("dynohot.fileWatcher.closables");

interface Closable {
	close(): void | Promise<void>;
}

function getClosables(): Set<Closable> {
	const g = globalThis as Record<symbol, unknown>;
	let set = g[WATCHER_SET_KEY] as Set<Closable> | undefined;
	if (!set) {
		set = new Set<Closable>();
		g[WATCHER_SET_KEY] = set;
	}
	return set;
}

/**
 * Register a closable (typically an `fs.FSWatcher`) for shutdown cleanup.
 * Returns a de-registration function — call it when the watcher is
 * closed normally, so the shutdown list doesn't grow unbounded.
 */
export function registerWatcherClosable(watcher: Closable): () => void {
	const set = getClosables();
	set.add(watcher);
	return () => {
		set.delete(watcher);
	};
}

/**
 * Close every registered watcher. Call this synchronously immediately
 * before a hard process exit so FSEvents stops dispatching before the V8
 * isolate dies.
 */
export async function closeAllWatchers(): Promise<void> {
	const set = getClosables();
	const all = [...set];
	set.clear();
	await Promise.allSettled(
		all.map((w) => {
			try {
				return w.close();
			} catch {
				return;
			}
		})
	);
}
