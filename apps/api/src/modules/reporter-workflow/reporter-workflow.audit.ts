export const REPORTER_WORKFLOW_AUDIT = {
  REPORTER_PROVISIONED: "reporter_provisioned",
  REPORTER_DEACTIVATED: "reporter_deactivated",
  REPORTER_REACTIVATED: "reporter_reactivated",
  INBOUND_EVENT_AUTHORIZED: "inbound_event_authorized",
  INBOUND_EVENT_IGNORED: "inbound_event_ignored",
  CONVERSATION_PROVISIONED: "conversation_provisioned",
  CONVERSATION_TRANSITIONED: "conversation_state_transitioned",
} as const;

export const IGNORED_REASON = {
  UNKNOWN: "REPORTER_UNKNOWN",
  INACTIVE: "REPORTER_INACTIVE",
} as const;
