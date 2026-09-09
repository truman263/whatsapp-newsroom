import type { Request, Response } from "express";
import type { RawBodyRequest } from "@nestjs/common";
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import { WhatsappWebhookIngestionService } from "./whatsapp-webhook-ingestion.service";
import {
  WhatsappWebhookNormalizer,
  WhatsappWebhookPayloadError,
} from "./whatsapp-webhook-normalizer";
import { WhatsappWebhookSignatureService } from "./whatsapp-webhook-signature.service";
import type { WebhookAcknowledgement } from "./whatsapp-webhook.types";
import { WhatsappWebhookVerificationService } from "./whatsapp-webhook-verification.service";

@Controller("webhooks/whatsapp")
export class WhatsappWebhookController {
  private readonly logger = new Logger(WhatsappWebhookController.name);

  constructor(
    private readonly verification: WhatsappWebhookVerificationService,
    private readonly signatures: WhatsappWebhookSignatureService,
    private readonly normalizer: WhatsappWebhookNormalizer,
    private readonly ingestion: WhatsappWebhookIngestionService,
  ) {}

  @Get()
  verify(
    @Query("hub.mode") mode: unknown,
    @Query("hub.verify_token") token: unknown,
    @Query("hub.challenge") challenge: unknown,
    @Res() response: Response,
  ): void {
    if (mode !== "subscribe" || !this.verification.tokenMatches(token)) {
      throw new ForbiddenException("Webhook verification failed.");
    }
    if (typeof challenge !== "string") {
      throw new BadRequestException("Webhook challenge is required.");
    }
    response.status(200).type("text/plain").send(challenge);
  }

  @Post()
  @HttpCode(200)
  async receive(
    @Req() request: RawBodyRequest<Request>,
  ): Promise<WebhookAcknowledgement> {
    if (!this.signatures.verify(request.rawBody, request.rawHeaders)) {
      throw new UnauthorizedException("Webhook authentication failed.");
    }
    try {
      const batch = this.normalizer.normalize(request.body);
      await this.ingestion.persist(batch);
      if (batch.foreignPhoneChanges > 0) {
        this.logger.warn({
          event: "foreign_phone_number_ignored",
          count: batch.foreignPhoneChanges,
        });
      }
      if (batch.unsupportedChanges > 0) {
        this.logger.log({
          event: "unsupported_webhook_change",
          count: batch.unsupportedChanges,
        });
      }
      return { received: true };
    } catch (error) {
      if (error instanceof WhatsappWebhookPayloadError) {
        throw new BadRequestException("Malformed webhook payload.");
      }
      throw error;
    }
  }
}
