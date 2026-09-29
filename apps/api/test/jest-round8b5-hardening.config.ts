import type { Config } from "jest";

const config: Config = {
  rootDir: "..",
  testEnvironment: "node",
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "tsconfig.json" }],
  },
  testMatch: [
    "<rootDir>/test/round8b5-hardening.integration-spec.ts",
    "<rootDir>/test/round8b5a-plans.integration-spec.ts",
    "<rootDir>/test/round8b5a-capacity.integration-spec.ts",
    "<rootDir>/test/round8b5a-media.integration-spec.ts",
  ],
  moduleFileExtensions: ["ts", "js", "json"],
  maxWorkers: 1,
};

export default config;
