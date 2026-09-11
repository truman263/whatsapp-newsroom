import {
  normalizeBody,
  normalizeHeadline,
} from "./story-event-processor.service";

describe("Story content boundaries", () => {
  it("counts headline Unicode code points and rejects normalized newlines", () => {
    expect(normalizeHeadline("  Headline  ")).toBe("Headline");
    expect(normalizeHeadline("line\r\nline")).toBeNull();
    expect(normalizeHeadline("line\rline")).toBeNull();
    expect(normalizeHeadline(" ")).toBeNull();
    expect(normalizeHeadline("😀".repeat(500))).toBe("😀".repeat(500));
    expect(normalizeHeadline("😀".repeat(501))).toBeNull();
  });

  it("measures body UTF-8 bytes while preserving normalized internals", () => {
    expect(normalizeBody("  One\r\n\rTwo  ")).toBe("One\n\nTwo");
    expect(normalizeBody(" ")).toBeNull();
    expect(normalizeBody("a".repeat(100_000))).toHaveLength(100_000);
    expect(normalizeBody("a".repeat(100_001))).toBeNull();
    expect(normalizeBody("😀".repeat(25_000))).not.toBeNull();
    expect(normalizeBody("😀".repeat(25_001))).toBeNull();
  });
});
