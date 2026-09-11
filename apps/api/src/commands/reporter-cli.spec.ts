import { runReporterCli } from "./reporter-cli";
import { ReporterProvisioningService } from "../modules/reporter-workflow/reporter-provisioning.service";
import type { PrismaService } from "../database/prisma.service";

describe("reporter operator CLI adapter", () => {
  const output = { log: jest.fn(), error: jest.fn() };

  beforeEach(() => jest.clearAllMocks());

  it("delegates explicit provision fields and prints only its stable outcome", async () => {
    const provision = jest
      .fn()
      .mockResolvedValue({ outcome: "CREATED", reporterId: "private-id" });
    const service = { provision } as unknown as ReporterProvisioningService;
    await expect(
      runReporterCli(
        [
          "reporter",
          "provision",
          "--phone",
          "+263771234567",
          "--display-name",
          "Reporter",
        ],
        service,
        output,
      ),
    ).resolves.toBe(0);
    expect(provision).toHaveBeenCalledWith({
      phoneNumber: "+263771234567",
      displayName: "Reporter",
      editorialByline: undefined,
    });
    expect(output.log).toHaveBeenCalledWith("CREATED");
    expect(JSON.stringify(output.log.mock.calls)).not.toContain("private-id");
  });

  it("returns stable result codes for conflicts, missing reporters, and invalid input", async () => {
    const conflict = {
      provision: jest
        .fn()
        .mockResolvedValue({
          outcome: "REPORTER_CONFLICT",
          reporterId: "private-id",
        }),
    } as unknown as ReporterProvisioningService;
    await expect(
      runReporterCli(
        [
          "reporter",
          "provision",
          "--phone",
          "+263771234567",
          "--display-name",
          "Other",
        ],
        conflict,
        output,
      ),
    ).resolves.toBe(3);
    const missing = {
      deactivate: jest.fn().mockResolvedValue({ outcome: "NOT_FOUND" }),
    } as unknown as ReporterProvisioningService;
    await expect(
      runReporterCli(
        ["reporter", "deactivate", "--phone", "+263771234567"],
        missing,
        output,
      ),
    ).resolves.toBe(4);
    const validating = new ReporterProvisioningService({} as PrismaService);
    await expect(
      runReporterCli(
        [
          "reporter",
          "provision",
          "--phone",
          "bad",
          "--display-name",
          "Reporter",
        ],
        validating,
        output,
      ),
    ).resolves.toBe(2);
    expect(output.error).toHaveBeenCalledWith("INVALID_PHONE_NUMBER");
  });

  it("redacts unexpected persistence errors", async () => {
    const service = {
      reactivate: jest
        .fn()
        .mockRejectedValue(new Error("secret database detail")),
    } as unknown as ReporterProvisioningService;
    await expect(
      runReporterCli(
        ["reporter", "reactivate", "--phone", "+263771234567"],
        service,
        output,
      ),
    ).resolves.toBe(1);
    expect(output.error).toHaveBeenCalledWith("PERSISTENCE_ERROR");
    expect(JSON.stringify(output.error.mock.calls)).not.toContain(
      "secret database detail",
    );
  });
});
