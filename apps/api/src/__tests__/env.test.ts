import { describe, expect, it } from "vitest";
import { LOCAL_JWT_SECRET, validateRuntimeConfiguration } from "../env";

describe("validateRuntimeConfiguration", () => {
  it("allows local development to use the documented default secret", () => {
    expect(() => validateRuntimeConfiguration({ NODE_ENV: "development" })).not.toThrow();
  });

  it("rejects the default or absent JWT secret in production", () => {
    expect(() => validateRuntimeConfiguration({ NODE_ENV: "production" })).toThrow("JWT_SECRET");
    expect(() => validateRuntimeConfiguration({ NODE_ENV: "production", JWT_SECRET: LOCAL_JWT_SECRET })).toThrow(
      "JWT_SECRET",
    );
  });

  it("requires a distinct liquidity bootstrap secret in production", () => {
    const JWT_SECRET = "a-long-random-production-secret";
    expect(() => validateRuntimeConfiguration({ NODE_ENV: "production", JWT_SECRET })).toThrow("LIQUIDITY_BOOTSTRAP_TOKEN");
    expect(() =>
      validateRuntimeConfiguration({
        NODE_ENV: "production",
        JWT_SECRET,
        LIQUIDITY_BOOTSTRAP_TOKEN: JWT_SECRET,
      }),
    ).toThrow("LIQUIDITY_BOOTSTRAP_TOKEN");
  });

  it("requires a non-default liquidity bot password in production", () => {
    const environment = {
      NODE_ENV: "production",
      JWT_SECRET: "a-long-random-production-secret",
      LIQUIDITY_BOOTSTRAP_TOKEN: "a-different-random-bootstrap-secret",
    };
    expect(() => validateRuntimeConfiguration(environment)).toThrow("LIQUIDITY_BOT_PASSWORD");
    expect(() =>
      validateRuntimeConfiguration({ ...environment, LIQUIDITY_BOT_PASSWORD: "botpassword" }),
    ).toThrow("LIQUIDITY_BOT_PASSWORD");
  });

  it("accepts explicit non-default production secrets", () => {
    expect(() =>
      validateRuntimeConfiguration({
        NODE_ENV: "production",
        JWT_SECRET: "a-long-random-production-secret",
        LIQUIDITY_BOOTSTRAP_TOKEN: "a-different-random-bootstrap-secret",
        LIQUIDITY_BOT_PASSWORD: "a-different-random-bot-password",
      }),
    ).not.toThrow();
  });
});
