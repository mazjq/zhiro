import { describe, it, expect } from "vitest";
import QRCode from "qrcode";
import { decodeQr } from "./qr.js";

describe("qr", () => {
  it("decodes a generated PNG QR code", async () => {
    const buf: Buffer = await QRCode.toBuffer("https://app.mokahr.com/campus-recruitment/voyah/146293", { type: "png", width: 320, margin: 4 });
    expect(decodeQr(buf, "image/png")).toEqual(["https://app.mokahr.com/campus-recruitment/voyah/146293"]);
  });
  it("returns [] for garbage", () => {
    expect(decodeQr(Buffer.from("nope"), "image/png")).toEqual([]);
  });
});
