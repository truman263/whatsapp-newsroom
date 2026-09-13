import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DRAFT_PREPARATION_CODES,
  DraftPreparationError,
} from "./draft-preparation.errors";

describe("DraftPreparation Round 6B.2 boundaries", () => {
  it("keeps every durable error code fixed and content-free", () => {
    expect(new Set(DRAFT_PREPARATION_CODES).size).toBe(
      DRAFT_PREPARATION_CODES.length,
    );
    for (const code of DRAFT_PREPARATION_CODES) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/u);
      expect(new DraftPreparationError(code)).toMatchObject({
        code,
        message: code,
      });
    }
  });

  it("keeps DraftPreparation out of AppModule while allowing the Round 6B.4 workflow integration", () => {
    const app = readFileSync(
      resolve(process.cwd(), "src/app.module.ts"),
      "utf8",
    );
    const inbound = readFileSync(
      resolve(
        process.cwd(),
        "src/modules/reporter-workflow/inbound-event-processing.service.ts",
      ),
      "utf8",
    );
    expect(app).not.toContain("DraftPreparationModule");
    expect(inbound).toContain("DraftPreparationService");
  });

  it("gates done and revise by cutover and does not enable approve controls", () => {
    const processor = readFileSync(
      resolve(
        process.cwd(),
        "src/modules/story-collection/story-event-processor.service.ts",
      ),
      "utf8",
    );
    expect(processor).toContain(
      'command === "newsroom:v1:story:done" || command === "/done"',
    );
    expect(processor).toContain(
      'command === "newsroom:v1:story:revise" || command === "/revise"',
    );
    expect(processor).toContain('return ignored("CONTROL_NOT_ENABLED")');
    expect(processor).toContain("round6DoneEnabled");
    expect(processor).not.toContain('"/approve"');
  });
});
