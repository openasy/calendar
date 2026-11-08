import { describe, expect, it } from "vitest";
import {
  addDays,
  choiceOf,
  describeRule,
  formatDuration,
  isoWeek,
  nthOfMonth,
  parseDuration,
  ruleFor,
  toLocal,
  toUtc,
  weekStart,
  zoned,
  type RuleWords,
} from "./time.ts";

describe("time zones", () => {
  it("turns a wall-clock time in a zone into the instant, both ways", () => {
    expect(new Date(toUtc("2026-11-09T10:00:00", "Europe/Istanbul")).toISOString()).toBe("2026-11-09T07:00:00.000Z");
    expect(toLocal(Date.parse("2026-11-09T07:00:00Z"), "Europe/Istanbul")).toBe("2026-11-09T10:00:00");
    expect(toLocal(Date.parse("2026-11-09T07:00:00Z"), "America/New_York")).toBe("2026-11-09T02:00:00");
    expect(zoned(Date.parse("2026-11-09T07:00:00Z"), "Asia/Tokyo")).toMatchObject({ hour: 16, weekday: 0 });
  });

  it("follows clock changes", () => {
    // Berlin moves from UTC+2 to UTC+1 on 25 October 2026.
    expect(new Date(toUtc("2026-10-24T09:00:00", "Europe/Berlin")).toISOString()).toBe("2026-10-24T07:00:00.000Z");
    expect(new Date(toUtc("2026-10-26T09:00:00", "Europe/Berlin")).toISOString()).toBe("2026-10-26T08:00:00.000Z");
    // 02:30 on 29 March 2026 does not exist there; it is taken as the hour after.
    expect(new Date(toUtc("2026-03-29T02:30:00", "Europe/Berlin")).toISOString()).toBe("2026-03-29T01:30:00.000Z");
  });

  it("counts days, weeks and months as dates", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(weekStart("2026-11-08")).toBe("2026-11-02");
    expect(isoWeek("2026-11-02")).toBe(45);
    expect(isoWeek("2027-01-01")).toBe(53);
  });

  it("reads and writes JSCalendar durations", () => {
    expect(parseDuration("PT1H30M")).toBe(90 * 60_000);
    expect(parseDuration("P1D")).toBe(86_400_000);
    expect(parseDuration("-PT15M")).toBe(-15 * 60_000);
    expect(formatDuration(90 * 60_000)).toBe("PT1H30M");
    expect(formatDuration(86_400_000 + 3_600_000)).toBe("P1DT1H");
    expect(formatDuration(0)).toBe("PT0S");
  });
});

const words: RuleWords = {
  every: (unit, n) => (n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`),
  weekdays: "Every weekday",
  onDays: (d) => `on ${d}`,
  onMonthDay: (d) => `on day ${d}`,
  onNth: (n, d) => `on the ${n} ${d}`,
  times: (c) => `${c} times`,
  until: (d) => `until ${d}`,
};

describe("repeating", () => {
  it("makes the rule for each choice of the form, and finds the choice again", () => {
    // Wednesday 25 November 2026 is the fourth and last Wednesday of the month.
    expect(ruleFor("weekly", "2026-11-25")).toEqual({ "@type": "RecurrenceRule", frequency: "weekly", byDay: [{ "@type": "NDay", day: "we" }] });
    expect(nthOfMonth("2026-11-25")).toEqual({ nth: 4, last: true });
    expect(ruleFor("monthly-nth", "2026-11-25")!.byDay).toEqual([{ "@type": "NDay", day: "we", nthOfPeriod: -1 }]);
    expect(ruleFor("monthly-nth", "2026-11-11")!.byDay).toEqual([{ "@type": "NDay", day: "we", nthOfPeriod: 2 }]);
    for (const c of ["none", "daily", "weekdays", "weekly", "monthly-day", "monthly-nth", "yearly"] as const)
      expect(choiceOf(ruleFor(c, "2026-11-25"), "2026-11-25")).toBe(c);
    expect(choiceOf({ frequency: "weekly", interval: 2, byDay: [{ day: "tu" }] }, "2026-11-24")).toBe("custom");
    expect(ruleFor("custom", "2026-11-24", { frequency: "weekly", interval: 2, days: ["tu", "th"] })).toEqual({
      "@type": "RecurrenceRule",
      frequency: "weekly",
      interval: 2,
      byDay: [
        { "@type": "NDay", day: "tu" },
        { "@type": "NDay", day: "th" },
      ],
    });
  });

  it("says in words how an event repeats", () => {
    expect(describeRule(ruleFor("weekdays", "2026-11-02")!, words, "en")).toBe("Every weekday");
    expect(describeRule({ frequency: "weekly", interval: 2, byDay: [{ day: "tu" }], count: 6 }, words, "en")).toBe("Every 2 weeks on Tuesday 6 times");
    expect(describeRule({ frequency: "monthly", byDay: [{ day: "mo", nthOfPeriod: 1 }], until: "2027-06-30T23:59:59" }, words, "en-GB")).toBe(
      "Every month on the 1 Monday until 30 June 2027",
    );
  });
});
