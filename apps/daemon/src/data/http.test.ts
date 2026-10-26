import { describe, it, expect, vi, afterEach } from "vitest";
import { publicAddress, assertPublic, guardedFetch } from "./http.js";

describe("addresses from outside never reach this machine or the local network", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("tells public addresses from private ones, IPv4-mapped IPv6 included", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) expect(publicAddress(ip), ip).toBe(false);
    for (const ip of ["93.184.216.34", "1.1.1.1", "198.18.0.5", "2606:4700:4700::1111"]) expect(publicAddress(ip), ip).toBe(true);
  });

  it("refuses private literals however they are written", async () => {
    for (const u of ["http://127.0.0.1:8787/", "http://[::ffff:127.0.0.1]/", "http://0x7f.1/", "http://2130706433/", "http://169.254.169.254/latest/meta-data", "file:///C:/x"]) await expect(assertPublic(u), u).rejects.toThrow(/^BLOCKED/);
  });

  it("checks every redirect hop, not only the first address", async () => {
    const fetch = vi.fn(async (u: string) => (u.endsWith("/a") ? new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8787/tool" } }) : new Response("inside")));
    vi.stubGlobal("fetch", fetch);
    await expect(guardedFetch("http://93.184.216.34/a")).rejects.toThrow(/^BLOCKED/);
    expect(fetch).toHaveBeenCalledTimes(1); // the private hop is never requested
  });

  it("follows public hops and turns a 303 into a GET", async () => {
    const fetch = vi.fn(async (u: string, init: RequestInit) => (u.endsWith("/a") ? new Response(null, { status: 303, headers: { location: "/b" } }) : new Response(`${init.method ?? "GET"} ${u}`)));
    vi.stubGlobal("fetch", fetch);
    expect(await (await guardedFetch("http://93.184.216.34/a", { method: "POST", body: "x" })).text()).toBe("GET http://93.184.216.34/b");
  });
});
