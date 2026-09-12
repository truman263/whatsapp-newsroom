import { ConfigService } from "@nestjs/config";
import { NewsroomPreviewController } from "./newsroom-preview.controller";
import { PreviewTokenService } from "./newsroom-preview-token.service";

const authority = {
  preparationId: "11111111-1111-4111-8111-111111111111",
  storyId: "22222222-2222-4222-8222-222222222222",
  storyVersion: 3,
  wordpressPostId: 7,
  wordpressAppliedVersion: "a".repeat(64),
  previewExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
  state: {},
};

describe("secure newsroom preview", () => {
  const preparations = {
    verifyPreparedAuthority: jest.fn().mockResolvedValue(authority),
  };
  const tokens = new PreviewTokenService(
    new ConfigService({
      preview: { hmacSecret: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" },
    }),
    preparations as never,
  );

  it("issues deterministic canonical capabilities and rejects malformed or tampered tokens", async () => {
    const token = await tokens.issue(authority.preparationId);
    expect(token.split(".")).toHaveLength(2);
    expect(token).not.toContain("=");
    expect(tokens.verify(token, new Date("2029-01-01"))).toMatchObject({
      v: 1,
      preparation_id: authority.preparationId,
      story_id: authority.storyId,
      story_version: 3,
      wordpress_applied_version: "a".repeat(64),
      exp: 1893456000,
    });
    for (const invalid of [
      "",
      `${token}=`,
      `${token}.extra`,
      `x${token.slice(1)}`,
      "x".repeat(2049),
    ])
      expect(() => tokens.verify(invalid, new Date("2029-01-01"))).toThrow();
    expect(() => tokens.verify(token, new Date("2030-01-01"))).toThrow(
      "PREVIEW_EXPIRED",
    );
  });

  it("serves a nonce-bound fragment-clearing shell without story-data HTML sinks", () => {
    const headers: Record<string, string> = {};
    let html = "";
    const response = {
      setHeader: (name: string, value: string): void => {
        headers[name] = value;
      },
      send: (value: string): void => {
        html = value;
      },
    };
    new NewsroomPreviewController({} as never).shell(response as never);
    expect(headers["Cache-Control"]).toBe("no-store");
    expect(headers["Content-Security-Policy"]).toContain("script-src 'nonce-");
    expect(headers["Content-Security-Policy"]).not.toMatch(
      /unsafe-inline|unsafe-eval|\*/,
    );
    expect(html).toContain("location.hash.slice(1)");
    expect(html).toContain("history.replaceState");
    expect(html).toContain("textContent");
    expect(html).not.toContain("innerHTML");
    expect(html).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
  });
});
