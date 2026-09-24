ALTER TABLE "InboundEvent"
ADD COLUMN "processingContractVersion" INTEGER;

CREATE INDEX "OutboundMessage_status_updatedAt_id_idx"
ON "OutboundMessage"("status", "updatedAt", "id");
