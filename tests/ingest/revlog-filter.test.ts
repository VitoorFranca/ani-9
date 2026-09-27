import { describe, expect, it } from "vitest";
import { filterRevlog } from "../../src/ingest/revlog-filter.js";
import type { RawRevlogEntry } from "../../src/ingest/types.js";

function entry(id: number, cid: number, ease: number, type: number, factor = 2500): RawRevlogEntry {
  return { id, cardId: cid, ease, factor, type };
}

describe("filterRevlog", () => {
  it("keeps genuine learning/review/relearning entries", () => {
    const raw = [entry(1, 100, 3, 0), entry(2, 100, 3, 1), entry(3, 100, 2, 2)];
    expect(filterRevlog(raw).map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it("drops manual (type 4) and rescheduled (type 5) entries", () => {
    const raw = [entry(1, 100, 3, 1), entry(2, 100, 0, 4, 2500), entry(3, 100, 0, 5), entry(4, 100, 3, 1)];
    expect(filterRevlog(raw).map((r) => r.id)).toEqual([1, 4]);
  });

  it("drops cramming (filtered, factor=0) but keeps genuine early review (filtered, factor!=0)", () => {
    const raw = [entry(1, 100, 3, 1), entry(2, 100, 3, 3, 0), entry(3, 100, 3, 3, 2600), entry(4, 100, 3, 1)];
    expect(filterRevlog(raw).map((r) => r.id)).toEqual([1, 3, 4]);
  });

  it("truncates history before a reset (manual, factor=0)", () => {
    const raw = [
      entry(1, 100, 3, 1),
      entry(2, 100, 3, 1),
      entry(3, 100, 0, 4, 0),
      entry(4, 100, 3, 0),
      entry(5, 100, 3, 1),
    ];
    expect(filterRevlog(raw).map((r) => r.id)).toEqual([4, 5]);
  });

  it("keeps only the history after the LAST reset when there are several", () => {
    const raw = [
      entry(1, 100, 3, 1),
      entry(2, 100, 0, 4, 0),
      entry(3, 100, 3, 0),
      entry(4, 100, 0, 4, 0),
      entry(5, 100, 3, 0),
    ];
    expect(filterRevlog(raw).map((r) => r.id)).toEqual([5]);
  });

  it("drops entries with ease <= 0 defensively", () => {
    const raw = [entry(1, 100, 0, 1), entry(2, 100, 3, 1)];
    expect(filterRevlog(raw).map((r) => r.id)).toEqual([2]);
  });

  it("handles multiple cards independently and returns globally chronological order", () => {
    const raw = [entry(2, 200, 3, 1), entry(1, 100, 3, 1), entry(3, 100, 3, 1)];
    expect(filterRevlog(raw).map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it("returns an empty array for a card whose only entries are the reset itself", () => {
    const raw = [entry(1, 100, 3, 1), entry(2, 100, 0, 4, 0)];
    expect(filterRevlog(raw)).toEqual([]);
  });
});
