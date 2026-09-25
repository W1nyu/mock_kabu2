import assert from "node:assert/strict";
import test from "node:test";
import { INDUSTRIES, industryById, industryCoverageProblem, industryOf } from "../dist/index.js";

test("every listed symbol belongs to exactly one industry", () => {
  assert.equal(industryCoverageProblem(), null);
});

test("industry lookups", () => {
  assert.equal(industryOf("SAEM")?.label, "헬스케어");
  assert.equal(industryOf("NOPE"), null);
  assert.equal(industryById("tech")?.symbols.includes("DAON"), true);
  assert.equal(new Set(INDUSTRIES.map((industry) => industry.id)).size, INDUSTRIES.length);
});
