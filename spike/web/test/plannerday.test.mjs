// Run with TZ=UTC to mimic LibreWolf resistFingerprinting: the result must not change.
import test from "node:test";
import assert from "node:assert/strict";
import { plannerDay } from "../static/plannerday.js";

const NY = "America/New_York";
const cases = [
  ["afternoon", "2026-11-06T20:00:00Z", "2026-11-06"],
  ["02:59 EST, before rollover", "2026-11-07T07:59:00Z", "2026-11-06"],
  ["03:00 EST, at rollover", "2026-11-07T08:00:00Z", "2026-11-07"],
  ["UTC next day, NY evening", "2026-11-07T03:30:00Z", "2026-11-06"],
  ["fall-back first 01:30 EDT", "2026-11-01T05:30:00Z", "2026-10-31"],
  ["fall-back second 01:30 EST", "2026-11-01T06:30:00Z", "2026-10-31"],
  ["fall-back 03:00 EST", "2026-11-01T08:00:00Z", "2026-11-01"],
  ["spring-forward 01:59 EST", "2027-03-14T06:59:00Z", "2027-03-13"],
  ["spring-forward 03:00 EDT", "2027-03-14T07:00:00Z", "2027-03-14"],
];
for (const [name, iso, want] of cases) {
  test(name, () => assert.equal(plannerDay(new Date(iso), NY, "03:00"), want));
}

test("the process default time zone does not matter", () => {
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone === NY, false, "run under TZ=UTC");
});
