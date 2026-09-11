import { ReporterWorkflowError } from "./reporter-workflow.errors";
import type { ProvisionReporterInput } from "./reporter-workflow.types";

const E164 = /^\+[1-9][0-9]{6,14}$/u;
const MAX_NAME = 200;

export type ValidatedReporterInput = {
  phoneNumber: string;
  displayName: string;
  editorialByline: string | null;
};

export function validatePhoneNumber(value: string): string {
  if (!E164.test(value))
    throw new ReporterWorkflowError("INVALID_PHONE_NUMBER");
  return value;
}

function requiredName(value: string): string {
  const result = value.trim();
  if (result.length === 0 || result.length > MAX_NAME) {
    throw new ReporterWorkflowError("INVALID_DISPLAY_NAME");
  }
  return result;
}

function optionalByline(value: string | null | undefined): string | null {
  if (value == null) return null;
  const result = value.trim();
  if (result.length > MAX_NAME) {
    throw new ReporterWorkflowError("INVALID_EDITORIAL_BYLINE");
  }
  return result.length === 0 ? null : result;
}

export function validateProvisionInput(
  input: ProvisionReporterInput,
): ValidatedReporterInput {
  return {
    phoneNumber: validatePhoneNumber(input.phoneNumber),
    displayName: requiredName(input.displayName),
    editorialByline: optionalByline(input.editorialByline),
  };
}
