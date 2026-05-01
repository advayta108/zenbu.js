import {
  RpcProvider,
  EventsProvider,
  KyjuClientProvider,
  useWsConnection,
  type WsConnectionState,
} from "#zenbu/init/src/renderer/lib/ws-connection"
import { KyjuProvider } from "#zenbu/init/src/renderer/lib/kyju-react"
import { PluginsScreen } from "./components/plugins-screen"

function ConnectedApp({
  connection,
}: {
  connection: Extract<WsConnectionState, { status: "connected" }>
}) {
  return (
    <RpcProvider value={connection.rpc}>
      <EventsProvider value={connection.events}>
        <KyjuClientProvider value={connection.kyjuClient}>
          <KyjuProvider
            client={connection.kyjuClient}
            replica={connection.replica}
          >
            <PluginsScreen />
          </KyjuProvider>
        </KyjuClientProvider>
      </EventsProvider>
    </RpcProvider>
  )
}

export function App() {
  const connection = useWsConnection()
  if (connection.status === "connecting") return <div className="h-full" />
  if (connection.status === "error") {
    return (
      <div className="flex h-full items-center justify-center text-red-500 text-xs">
        {connection.error}
      </div>
    )
  }
  return <ConnectedApp connection={connection} />
}
