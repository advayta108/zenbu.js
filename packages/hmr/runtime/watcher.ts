import { statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isWatcherPathPaused } from "./pause.js";
import { safeSubscribe, type SafeSubscription } from "./safe-subscribe.js";
import { debounceAsync } from "./utility.js";

// Q: Why @parcel/watcher instead of node:fs.watch?
// A: Node's fs.watch on macOS is a thin wrapper over FSEvents and has
// documented reliability holes: it drops events or delivers
// `filename=null` for atomic rename-replace (the pattern git uses, and
// many editors use for atomic saves). Result: editing a file via
// `git pull` — or any rename-replace — silently skipped the watcher
// and dynohot never reloaded. @parcel/watcher is the native FSEvents
// wrapper VSCode, Vite, Parcel, Tailwind's JIT, etc. all use. It
// normalizes OS events into clean { type, path } batches with no
// null-filename drops and correct rename-replace handling.

interface DirectoryWatcher {
	callbacksByFile: Map<string, CallbacksByFile>;
	directoryCallbacks: CallbacksByFile;
	subscription: SafeSubscription;
}

interface CallbacksByFile {
	callbacks: Set<() => void>;
	dispatch: () => Promise<void>;
}

/** @internal */
export class FileWatcher {
	private readonly watchers = new Map<string, DirectoryWatcher>();

	watch(url: string, callback: () => void) {
		if (!url.startsWith("file://")) {
			return;
		}
		const path = fileURLToPath(url);
		const watchesDirectory = isExistingDirectory(path);
		const fileName = basename(path);
		const directory = watchesDirectory ? path : dirname(path);
		// Initialize directory watcher
		const directoryWatcher = this.watchers.get(directory) ?? (() => {
			const callbacksByFile = new Map<string, CallbacksByFile>();
			const directoryCallbacks = makeCallbacks(directory);
			// `subscribe` is recursive; filter to direct children of
			// `directory` so semantics match the previous fs.watch(dir).
			// `safeSubscribe` handles the close-before-subscribe-resolves
			// race AND auto-registers for process-wide shutdown cleanup.
			const subscription = safeSubscribe(directory, (err, events) => {
				if (err) return;
				for (const event of events) {
					if (dirname(event.path) !== directory) continue;
					if (event.type !== "update") void directoryCallbacks.dispatch();
					const byFile = callbacksByFile.get(basename(event.path));
					if (byFile) void byFile.dispatch();
				}
			});
			const holder: DirectoryWatcher = {
				callbacksByFile,
				directoryCallbacks,
				subscription,
			};
			this.watchers.set(directory, holder);
			return holder;
		})();
		const byFile = watchesDirectory
			? directoryWatcher.directoryCallbacks
			: getFileCallbacks(directoryWatcher, fileName, path);
		byFile.callbacks.add(callback);
		return () => {
			byFile.callbacks.delete(callback);
			if (!watchesDirectory && byFile.callbacks.size === 0) {
				directoryWatcher.callbacksByFile.delete(fileName);
			}
			if (
				directoryWatcher.callbacksByFile.size === 0 &&
				directoryWatcher.directoryCallbacks.callbacks.size === 0
			) {
				this.watchers.delete(directory);
				void directoryWatcher.subscription.close();
			}
		};
	}
}

function getFileCallbacks(
	directoryWatcher: DirectoryWatcher,
	fileName: string,
	path: string,
): CallbacksByFile {
	const existing = directoryWatcher.callbacksByFile.get(fileName);
	if (existing) return existing;
	const byFile = makeCallbacks(path);
	directoryWatcher.callbacksByFile.set(fileName, byFile);
	return byFile;
}

function isExistingDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function makeCallbacks(path: string): CallbacksByFile {
	const callbacks = new Set<() => void>();
	const dispatch = debounceAsync(async () => {
		// If a caller has paused this path (e.g. during git
		// pull + pnpm install), suppress callbacks until resume.
		if (isWatcherPathPaused(path)) return;
		for (const callback of callbacks) {
			callback();
		}
	});
	return { callbacks, dispatch };
}
