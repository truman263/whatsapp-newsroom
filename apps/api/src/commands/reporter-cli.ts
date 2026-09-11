import { PrismaService } from "../database/prisma.service";
import { ReporterProvisioningService } from "../modules/reporter-workflow/reporter-provisioning.service";
import { ReporterWorkflowError } from "../modules/reporter-workflow/reporter-workflow.errors";

type Output = Pick<Console, "log" | "error">;

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

export async function runReporterCli(
  args: readonly string[],
  service: ReporterProvisioningService,
  output: Output,
): Promise<number> {
  const [group, operation] = args;
  if (group !== "reporter" || !operation) {
    output.error("INVALID_COMMAND");
    return 2;
  }
  try {
    const phoneNumber = option(args, "--phone");
    if (!phoneNumber) throw new ReporterWorkflowError("INVALID_PHONE_NUMBER");
    if (operation === "provision") {
      const displayName = option(args, "--display-name");
      if (displayName === undefined)
        throw new ReporterWorkflowError("INVALID_DISPLAY_NAME");
      const result = await service.provision({
        phoneNumber,
        displayName,
        editorialByline: option(args, "--editorial-byline"),
      });
      output.log(result.outcome);
      return result.outcome === "REPORTER_CONFLICT" ? 3 : 0;
    }
    if (operation === "deactivate" || operation === "reactivate") {
      const result =
        operation === "deactivate"
          ? await service.deactivate(phoneNumber)
          : await service.reactivate(phoneNumber);
      output.log(result.outcome);
      return result.outcome === "NOT_FOUND" ? 4 : 0;
    }
    output.error("INVALID_COMMAND");
    return 2;
  } catch (error: unknown) {
    if (error instanceof ReporterWorkflowError) {
      output.error(error.code);
      return 2;
    }
    output.error("PERSISTENCE_ERROR");
    return 1;
  }
}

async function main(): Promise<void> {
  const prisma = new PrismaService();
  const service = new ReporterProvisioningService(prisma);
  try {
    await prisma.$connect();
    process.exitCode = await runReporterCli(
      process.argv.slice(2),
      service,
      console,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch(() => {
    console.error("PERSISTENCE_ERROR");
    process.exitCode = 1;
  });
}
