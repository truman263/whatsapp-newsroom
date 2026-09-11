import { ConversationState } from "@prisma/client";
import { validateTransition } from "./conversation-state-machine";
import { ReporterWorkflowError } from "./reporter-workflow.errors";
import { validateProvisionInput } from "./reporter-validation";

function expectCode(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ReporterWorkflowError);
    expect((error as ReporterWorkflowError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe("reporter workflow validation", () => {
  it("normalizes names and deterministically maps an empty byline to null", () => {
    expect(
      validateProvisionInput({
        phoneNumber: "+263771234567",
        displayName: "  Reporter One  ",
        editorialByline: "   ",
      }),
    ).toEqual({
      phoneNumber: "+263771234567",
      displayName: "Reporter One",
      editorialByline: null,
    });
  });

  it.each(["263771234567", "+01234567", "+123456", "+1234567890123456"])(
    "rejects invalid E.164 %s",
    (phoneNumber) => {
      expectCode(
        () => validateProvisionInput({ phoneNumber, displayName: "Reporter" }),
        "INVALID_PHONE_NUMBER",
      );
    },
  );

  it("rejects blank and overlength names and overlength bylines", () => {
    expectCode(
      () =>
        validateProvisionInput({
          phoneNumber: "+263771234567",
          displayName: " ",
        }),
      "INVALID_DISPLAY_NAME",
    );
    expectCode(
      () =>
        validateProvisionInput({
          phoneNumber: "+263771234567",
          displayName: "x".repeat(201),
        }),
      "INVALID_DISPLAY_NAME",
    );
    expectCode(
      () =>
        validateProvisionInput({
          phoneNumber: "+263771234567",
          displayName: "Reporter",
          editorialByline: "x".repeat(201),
        }),
      "INVALID_EDITORIAL_BYLINE",
    );
  });
});

describe("frozen conversation transition graph", () => {
  it.each([
    [
      ConversationState.IDLE,
      ConversationState.AWAITING_HEADLINE,
      { kind: "ATTACH", storyId: "story" },
    ],
    [
      ConversationState.AWAITING_HEADLINE,
      ConversationState.AWAITING_BODY,
      { kind: "PRESERVE" },
    ],
    [
      ConversationState.AWAITING_BODY,
      ConversationState.COLLECTING_MEDIA,
      { kind: "PRESERVE" },
    ],
    [
      ConversationState.COLLECTING_MEDIA,
      ConversationState.AWAITING_APPROVAL,
      { kind: "PRESERVE" },
    ],
    [
      ConversationState.AWAITING_APPROVAL,
      ConversationState.COLLECTING_MEDIA,
      { kind: "PRESERVE" },
    ],
    [
      ConversationState.AWAITING_APPROVAL,
      ConversationState.PUBLISHING,
      { kind: "PRESERVE" },
    ],
    [ConversationState.PUBLISHING, ConversationState.IDLE, { kind: "CLEAR" }],
  ] as const)(
    "allows %s -> %s with its required mutation",
    (from, to, mutation) => {
      expect(() => validateTransition(from, to, mutation)).not.toThrow();
    },
  );

  it("rejects self transitions, non-frozen edges, and mismatched mutations", () => {
    expectCode(
      () =>
        validateTransition(ConversationState.IDLE, ConversationState.IDLE, {
          kind: "CLEAR",
        }),
      "INVALID_TRANSITION",
    );
    expectCode(
      () =>
        validateTransition(
          ConversationState.IDLE,
          ConversationState.AWAITING_BODY,
          { kind: "ATTACH", storyId: "story" },
        ),
      "INVALID_TRANSITION",
    );
    expectCode(
      () =>
        validateTransition(
          ConversationState.IDLE,
          ConversationState.AWAITING_HEADLINE,
          { kind: "PRESERVE" },
        ),
      "INVALID_STORY_MUTATION",
    );
    expectCode(
      () =>
        validateTransition(
          ConversationState.AWAITING_HEADLINE,
          ConversationState.AWAITING_BODY,
          { kind: "ATTACH", storyId: "story" },
        ),
      "INVALID_STORY_MUTATION",
    );
    expectCode(
      () =>
        validateTransition(
          ConversationState.AWAITING_HEADLINE,
          ConversationState.IDLE,
          { kind: "PRESERVE" },
        ),
      "INVALID_STORY_MUTATION",
    );
  });
});
