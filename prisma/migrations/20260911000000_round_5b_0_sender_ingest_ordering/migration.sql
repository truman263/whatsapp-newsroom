-- Round 5B.0 controlled-offline adoption of deterministic per-sender
-- authenticated ingestion order. This is local durable ingestion order, not
-- reconstructed WhatsApp send order.

CREATE TABLE "InboundSenderSequence" (
    "senderPhone" VARCHAR(16) NOT NULL,
    "nextValue" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "InboundSenderSequence_pkey" PRIMARY KEY ("senderPhone")
);

ALTER TABLE "InboundEvent"
    ADD COLUMN "senderIngestSequence" BIGINT;

WITH ordered AS (
    SELECT
        "id",
        ROW_NUMBER() OVER (
            PARTITION BY "senderPhone"
            ORDER BY "receivedAt" ASC, "id" ASC
        ) - 1 AS sequence_value
    FROM "InboundEvent"
)
UPDATE "InboundEvent" AS event
SET "senderIngestSequence" = ordered.sequence_value
FROM ordered
WHERE event."id" = ordered."id";

INSERT INTO "InboundSenderSequence" ("senderPhone", "nextValue", "updatedAt")
SELECT
    "senderPhone",
    MAX("senderIngestSequence") + 1,
    CURRENT_TIMESTAMP
FROM "InboundEvent"
GROUP BY "senderPhone";

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM "InboundEvent" WHERE "senderIngestSequence" IS NULL) THEN
        RAISE EXCEPTION 'Round 5B.0 backfill left NULL senderIngestSequence values';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "InboundEvent"
        GROUP BY "senderPhone", "senderIngestSequence"
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'Round 5B.0 backfill produced duplicate sender ingestion sequences';
    END IF;
END $$;

ALTER TABLE "InboundEvent"
    ALTER COLUMN "senderIngestSequence" SET NOT NULL;

CREATE UNIQUE INDEX "InboundEvent_senderPhone_senderIngestSequence_key"
    ON "InboundEvent"("senderPhone", "senderIngestSequence");

CREATE INDEX "InboundEvent_senderPhone_processingStatus_senderIngestSeque_idx"
    ON "InboundEvent"("senderPhone", "processingStatus", "senderIngestSequence");
