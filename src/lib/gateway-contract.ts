/**
 * JSON-RPC methods HermesBot calls on the Hermes gateway (WebSocket `hermes-gateway-v1`).
 * The simulated gateway in tests/e2e.mjs must implement each required method.
 */

export type GatewayMethodRequirement = 'required' | 'optional' | 'rooms'

export interface GatewayMethodRow {
  method: string
  requirement: GatewayMethodRequirement
  /** Short note for docs and the contract test. */
  note: string
}

/** Hermes versions this table was last checked against (read-only, upstream release tags). */
export const GATEWAY_CONTRACT_VERSIONS = [
  {
    hermes: '0.23.0',
    note: 'Baseline for profiles.configure, session.steer, subagent.*',
  },
  {
    hermes: '0.23.2',
    note: 'groups.* room driver, idempotent_send, replayable_disband',
  },
] as const

export const HERMESBOT_GATEWAY_METHODS: readonly GatewayMethodRow[] = [
  { method: 'client.capabilities', requirement: 'required', note: 'Announces server-request handling' },
  { method: 'gateway.ping', requirement: 'required', note: 'Heartbeat' },
  { method: 'profiles.list', requirement: 'required', note: 'Roster' },
  { method: 'profiles.create', requirement: 'optional', note: 'New bot from the app' },
  { method: 'profiles.configure', requirement: 'optional', note: 'Bot card in ui_meta' },
  { method: 'session.list', requirement: 'required', note: 'Find Bot Chat session' },
  { method: 'session.create', requirement: 'required', note: 'Open Bot Chat' },
  { method: 'session.title', requirement: 'optional', note: 'Bot Chat title' },
  { method: 'session.resume', requirement: 'required', note: 'Load conversation' },
  { method: 'session.history', requirement: 'required', note: 'Transcript and notifications' },
  { method: 'session.active_list', requirement: 'required', note: 'Working bots' },
  { method: 'session.events.since', requirement: 'required', note: 'Live updates' },
  { method: 'prompt.submit', requirement: 'required', note: 'Send message' },
  { method: 'session.steer', requirement: 'required', note: 'Queue / priority while working' },
  { method: 'session.interrupt', requirement: 'required', note: 'Stop' },
  { method: 'session.mutate', requirement: 'required', note: 'Model switch per conversation' },
  { method: 'session.compress', requirement: 'required', note: 'Manual compaction' },
  { method: 'session.stats', requirement: 'optional', note: 'Usage panel (preferred)' },
  { method: 'session.usage', requirement: 'optional', note: 'Usage panel fallback' },
  { method: 'session.context_breakdown', requirement: 'optional', note: 'Context breakdown' },
  { method: 'model.options', requirement: 'required', note: 'Model picker' },
  { method: 'setup.runtime_check', requirement: 'optional', note: 'Provider key probe' },
  { method: 'image.attach_bytes', requirement: 'required', note: 'Image upload' },
  { method: 'file.attach', requirement: 'required', note: 'File upload' },
  { method: 'clarify.respond', requirement: 'required', note: 'Question cards' },
  { method: 'approval.respond', requirement: 'required', note: 'Approval dialogs' },
  { method: 'config.get', requirement: 'optional', note: 'Read-only gateway settings (approvals.mode)' },
  { method: 'subagent.roster', requirement: 'optional', note: 'Standing-by status' },
  { method: 'process.list', requirement: 'optional', note: 'Background processes' },
  { method: 'subagent.list', requirement: 'optional', note: 'Subagents panel' },
  { method: 'subagent.tail', requirement: 'optional', note: 'Subagent log' },
  { method: 'groups.capabilities', requirement: 'rooms', note: 'Room feature gate' },
  { method: 'groups.list', requirement: 'rooms', note: 'Room roster' },
  { method: 'groups.create', requirement: 'rooms', note: 'New room' },
  { method: 'groups.state', requirement: 'rooms', note: 'Room snapshot' },
  { method: 'groups.log', requirement: 'rooms', note: 'Room events' },
  { method: 'groups.send', requirement: 'rooms', note: 'Room message' },
  { method: 'groups.stop', requirement: 'rooms', note: 'Stop room work' },
  { method: 'groups.rename', requirement: 'rooms', note: 'Rename room' },
  { method: 'groups.disband', requirement: 'rooms', note: 'Delete room' },
] as const

export const REQUIRED_GATEWAY_METHODS = HERMESBOT_GATEWAY_METHODS
  .filter((row) => row.requirement === 'required')
  .map((row) => row.method)