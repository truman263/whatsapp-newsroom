/** Explicitly supported durable inbound processing contracts. */
export const CURRENT_INBOUND_PROCESSING_CONTRACT_VERSION = 1;

const SUPPORTED_INBOUND_PROCESSING_CONTRACT_VERSIONS: ReadonlySet<number> =
  new Set([CURRENT_INBOUND_PROCESSING_CONTRACT_VERSION]);

export function supportsInboundProcessingContractVersion(
  version: number | null,
): boolean {
  return (
    version !== null &&
    Number.isSafeInteger(version) &&
    SUPPORTED_INBOUND_PROCESSING_CONTRACT_VERSIONS.has(version)
  );
}
