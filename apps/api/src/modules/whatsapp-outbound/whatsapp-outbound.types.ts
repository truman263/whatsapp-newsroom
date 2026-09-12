export type ApprovalPromptPayload = {
  kind: "APPROVAL_PROMPT_V1";
  draftPreparationId: string;
  storyId: string;
  storyVersion: number;
  wordpressAppliedVersion: string;
};

export type MetaTransportRequest = {
  url: string;
  headers: Readonly<Record<string, string>>;
  body: string;
  timeoutMs: number;
};
export type MetaTransportResponse = { status: number; body: unknown };
export interface MetaOutboundTransport {
  send(request: MetaTransportRequest): Promise<MetaTransportResponse>;
}
export const META_OUTBOUND_TRANSPORT = Symbol("META_OUTBOUND_TRANSPORT");

export type DispatchResult =
  | "SENT"
  | "FAILED"
  | "OUTCOME_UNCERTAIN"
  | "NOT_CLAIMED"
  | "MANUAL_RECONCILIATION_REQUIRED";

export type ProviderStatusInput = {
  providerMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  occurredAt?: Date;
};
