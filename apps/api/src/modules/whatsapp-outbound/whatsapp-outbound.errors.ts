export type WhatsappOutboundCode =
  | "WHATSAPP_AUTHENTICATION_FAILURE"
  | "WHATSAPP_REQUEST_REJECTED"
  | "WHATSAPP_PROMPT_CONTRACT_FAILURE"
  | "WHATSAPP_SEND_OUTCOME_UNCERTAIN"
  | "WHATSAPP_PROMPT_IDENTITY_CONFLICT";

export class WhatsappOutboundError extends Error {
  constructor(
    public readonly code: WhatsappOutboundCode,
    public readonly uncertain = false,
  ) {
    super(code);
    this.name = "WhatsappOutboundError";
  }
}
