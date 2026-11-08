import { describe, expect, it } from "vitest";
import { collections, davData, fold, joinCalendars, joinCards, unfold } from "./ics.ts";

const ONE = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTIMEZONE\r\nTZID:Europe/Istanbul\r\nBEGIN:STANDARD\r\nDTSTART:20251231T030000\r\nTZOFFSETFROM:+0300\r\nTZOFFSETTO:+0300\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART;TZID=Europe/Istanbul:20261109T100000\r\nDURATION:PT1H\r\nRRULE:FREQ=WEEKLY;COUNT=10\r\nSUMMARY:Board, with the plan\r\nDESCRIPTION:Numbers\r\nATTENDEE;CN=Ali:mailto:ali@example.com\r\nBEGIN:VALARM\r\nTRIGGER:-PT15M\r\nACTION:DISPLAY\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
const TWO = ONE.replace("UID:a", "UID:b")
  .replace("SUMMARY:Board, with the plan", "SUMMARY:Lunch")
  .replace("ATTENDEE;CN=Ali:mailto:ali@example.com\r\n", "TRANSP:TRANSPARENT\r\n");

describe("iCalendar files from CalDAV", () => {
  it("reads calendar data from a Multi-Status answer, in CDATA or escaped", () => {
    const xml = `<D:multistatus><D:response><A:calendar-data><![CDATA[${ONE}]]></A:calendar-data></D:response><D:response><A:calendar-data>BEGIN:VCALENDAR&#13;
SUMMARY:a &amp; b
END:VCALENDAR</A:calendar-data></D:response></D:multistatus>`;
    const docs = davData(xml, "calendar-data");
    expect(docs).toHaveLength(2);
    expect(docs[0]).toBe(ONE);
    expect(docs[1]).toContain("SUMMARY:a & b");
  });

  it("joins calendars into one, with each time zone once", () => {
    const ics = joinCalendars([ONE, TWO], { name: "Jane; work" });
    expect(ics.match(/BEGIN:VTIMEZONE/g)).toHaveLength(1);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics).toContain(String.raw`X-WR-CALNAME:Jane\; work` + "\r\n");
    expect(ics).toContain("BEGIN:VALARM");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("shows only times for free and busy, leaving out free events", () => {
    const ics = joinCalendars([ONE, TWO], { name: "Jane", busy: "Busy" });
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(ics).toContain("SUMMARY:Busy");
    expect(ics).toContain("RRULE:FREQ=WEEKLY;COUNT=10");
    expect(ics).toContain("DTSTART;TZID=Europe/Istanbul:20261109T100000");
    expect(ics).not.toMatch(/Board|Numbers|ATTENDEE|VALARM|Lunch/);
  });

  it("folds long lines at 75 octets without splitting a character, and unfolds them", () => {
    const long = `SUMMARY:${"ğ".repeat(60)}`;
    const folded = fold(long);
    for (const line of folded.split("\r\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    expect(unfold(folded)).toEqual([long]);
  });

  it("joins vCards", () => {
    expect(joinCards(["BEGIN:VCARD\r\nFN:A\r\nEND:VCARD\r\n", "BEGIN:VCARD\r\nFN:B\r\nEND:VCARD"])).toBe(
      "BEGIN:VCARD\r\nFN:A\r\nEND:VCARD\r\nBEGIN:VCARD\r\nFN:B\r\nEND:VCARD\r\n",
    );
  });

  it("finds the calendars and address books of a PROPFIND by name", () => {
    const xml = `<D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/cal/jane%40example.com/</D:href><D:propstat><D:prop><D:displayname>Jane</D:displayname><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response><D:response><D:href>/dav/cal/jane%40example.com/gIRN/</D:href><D:propstat><D:prop><D:displayname>Work &amp; travel</D:displayname><D:resourcetype><D:collection/><A:calendar/></D:resourcetype></D:prop></D:propstat></D:response></D:multistatus>`;
    expect(collections(xml)).toEqual([{ href: "/dav/cal/jane%40example.com/gIRN/", name: "Work & travel" }]);
  });
});
