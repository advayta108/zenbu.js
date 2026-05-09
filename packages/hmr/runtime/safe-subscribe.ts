import { subscribe, type AsyncSubscription } from "@parcel/watcher"
import { registerWatcherClosable } from "./pause.js"

interface ParcelEvent {
	path: string
	type: "create" | "update" | "delete"
}

/**
 * Wrap `@parcel/watcher#subscribe` so the returned closable AWAITS the
 * subscribe promise before unsubscribing.
 *
 * The naive pattern —
 *
 *   let sub = null
 *   subscribe(dir, cb).then(s => { if (closed) s.unsubscribe(); else sub = s })
 *   close = () => sub?.unsubscribe()
 *
 * — has a quiet race on shutdown: if `close()` runs while the subscribe
 * promise is still pending, the eventual unsubscribe call is unawaited.
 * The parcel-watcher native worker fires its work-complete callback into
 * a torn-down NAPI env → `Error::ThrowAsJavaScriptException napi_throw`
 * fatal. This helper hides the awaiting so call sites can't get it wrong.
 *
 * Auto-registers for shutdown via `registerWatcherClosable`, so callers
 * don't need a separate `registerWatcherClosable(closable)` line. The
 * returned `deregister()` is for runtime cleanup (e.g. when a watcher is
 * no longer needed mid-process); shutdown is handled regardless.
 */
export interface SafeSubscription {
	/** Manually unsubscribe + drop from the shutdown registry. */
	close(): Promise<void>
}

export function safeSubscribe(
	directory: string,
	onEvents: (err: Error | null, events: ParcelEvent[]) => void,
): SafeSubscription {
	const subscriptionPromise: Promise<AsyncSubscription | null> = subscribe(
		directory,
		onEvents,
	).catch((err: unknown) => {
		console.error(`[zenbu safeSubscribe] subscribe failed for ${directory}:`, err)
		return null
	})

	const closable = {
		close: async () => {
			const sub = await subscriptionPromise
			if (sub) {
				try {
					await sub.unsubscribe()
				} catch {
					// Already torn down; nothing to do.
				}
			}
		},
	}

	const deregister = registerWatcherClosable(closable)

	return {
		close: async () => {
			deregister()
			await closable.close()
		},
	}
}
