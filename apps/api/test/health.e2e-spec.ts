import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/database/prisma.service";

describe("Health endpoint (e2e)", () => {
  let app: INestApplication;
  const database = { $queryRaw: jest.fn().mockResolvedValue([{ one: 1 }]) };

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(database)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => app.close());

  it("GET /health", async () => {
    // Nest intentionally exposes the platform server as `any`; Supertest validates it at runtime.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await request(app.getHttpServer())
      .get("/health")
      .expect(200)
      .expect({ status: "ok", service: "newsroom-api" });
  });

  it("keeps liveness healthy while database failure makes readiness HTTP 503", async () => {
    database.$queryRaw.mockRejectedValueOnce(new Error("database unavailable"));
    // Nest intentionally exposes the platform server as `any`; Supertest validates it at runtime.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await request(app.getHttpServer())
      .get("/health/ready")
      .expect(503)
      .expect({
        status: "not_ready",
        service: "newsroom-api",
        reason: "database_unavailable",
      });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await request(app.getHttpServer())
      .get("/health/live")
      .expect(200)
      .expect({ status: "ok", service: "newsroom-api" });
  });
});
