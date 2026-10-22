/** Following the computer's zone when Node cannot name it (Windows' Alberta zone, 2026). */
import { describe, it, expect } from "vitest";
import { zoneFor } from "./env.js";

describe("the zone to run in", () => {
  it("a known newer Windows zone by name; else the computer's offset now; nothing for a half hour off", () => {
    expect(zoneFor("Alberta Standard Time", 360)).toBe("America/Edmonton");
    expect(zoneFor("Some Future Zone", 360)).toBe("Etc/GMT+6");
    expect(zoneFor("Some Future Zone", -480)).toBe("Etc/GMT-8");
    expect(zoneFor("Some Future Zone", 0)).toBe("Etc/UTC");
    expect(zoneFor("Some Future Zone", -330)).toBeNull();
    expect(new Intl.DateTimeFormat("en", { timeZone: zoneFor("x", 360)!, timeZoneName: "shortOffset" }).format(new Date())).toContain("GMT-6");
  });
});
