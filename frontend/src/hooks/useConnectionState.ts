import { useEffect, useState } from 'react'
import wsClient, { type ConnectionState } from '../services/websocket'

/**
 * Subscribes to the websocket connection state.
 * Components use this to render a live/reconnecting indicator.
 */
export function useConnectionState(): ConnectionState {
  const [state, setState] = useState<ConnectionState>(wsClient.getState())
  useEffect(() => wsClient.onStateChange(setState), [])
  return state
}
