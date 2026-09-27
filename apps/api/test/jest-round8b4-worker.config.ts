import type { Config } from "jest";
const config: Config = { rootDir: "..", testEnvironment: "node", transform: { "^.+\\.ts$": ["ts-jest", { tsconfig: "tsconfig.json" }] }, testMatch: ["<rootDir>/test/round8b4-worker.integration-spec.ts"], moduleFileExtensions: ["ts", "js", "json"], maxWorkers: 1 };
export default config;
