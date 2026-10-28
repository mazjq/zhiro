import { describe, it, expect } from "vitest";
import { encode as encodeJpeg, decode as decodeJpeg } from "jpeg-js";
import { articleText, noticeToListings, slices, MAX_PIXELS, type NoticeExtraction } from "./extract.js";

describe("a long poster goes to the model in slices", () => {
  const jpeg = (width: number, height: number) => Buffer.from(encodeJpeg({ data: new Uint8Array(width * height * 4).fill(200), width, height }, 80).data);
  it("cut top to bottom within the budget, overlapping, covering it all; one that fits is sent as it is", () => {
    const parts = slices(jpeg(1080, 6000), "image/jpeg")!;
    const dims = parts.map((p) => decodeJpeg(p));
    expect(dims.length).toBe(3);
    expect(dims.every((d) => d.width === 1080 && d.width * d.height <= MAX_PIXELS)).toBe(true);
    expect(dims.reduce((s, d) => s + d.height, 0)).toBeGreaterThan(6000); // the overlaps
    expect(slices(jpeg(1080, 1500), "image/jpeg")).toBeNull();
    expect(slices(Buffer.from("x"), "image/webp")).toBeNull();
  });
});

describe("extract", () => {
  it("pulls mp.weixin article text and title", () => {
    const html = `<html><head><title>某公司2027届秋招启动 - 微信</title></head><body><h1 id="activity-name" class="rich_media_title">
      某公司2027届秋季校园招聘
    </h1><div id="js_content"><p>一、招聘对象</p><p>2027届硕士、博士</p><section><div><div></div></div>二、岗位<br>控制算法工程师</section>
    <img data-src="https://mmbiz.qpic.cn/mmbiz_png/abc/640?wx_fmt=png&amp;from=appmsg"><img data-src="https://mmbiz.qpic.cn/mmbiz_png/abc/640?wx_fmt=png&amp;from=appmsg"></div><div id="js_pc_qr_code">二维码</div><script>x()</script></body></html>`;
    const a = articleText(html, "https://mp.weixin.qq.com/s/abc");
    expect(a.title).toBe("某公司2027届秋季校园招聘");
    expect(a.text).toContain("一、招聘对象");
    expect(a.text).toContain("控制算法工程师");
    expect(a.text).not.toContain("x()");
    expect(a.text).not.toContain("二维码");
    expect(a.images).toEqual(["https://mmbiz.qpic.cn/mmbiz_png/abc/640?wx_fmt=png&from=appmsg"]);
  });
  it("maps an extraction to listings with grade by publisher type", () => {
    const ex: NoticeExtraction = { isRecruitment: true, company: "示例研究院", publisherType: "高校就业网", cohort: "2027届", batch: "秋招", kind: "博士专项", deadlineText: "2026年10月20日", applyUrl: "https://hr.example.com/apply", cities: ["武汉"], degreeReq: "博士", majorReq: "控制", positions: [{ title: "控制算法", cities: [], degreeReq: "", majorReq: "", jd: "做控制" }, { title: "仿真", cities: ["上海"], degreeReq: "硕士", majorReq: "", jd: "" }], notes: "有笔试" };
    const ls = noticeToListings(ex, "https://job.example.edu.cn/n/1", "capture");
    expect(ls).toHaveLength(2);
    expect(ls[0]).toMatchObject({ company: "示例研究院", grade: "校方转载", isOriginal: false, url: "https://hr.example.com/apply", locations: ["武汉"], degreeReq: "博士", cohort: "2027届", batch: "秋招", kind: "博士专项", deadlineText: "2026年10月20日", publisher: "capture:job.example.edu.cn" });
    expect(ls[1]).toMatchObject({ title: "仿真", locations: ["上海"], degreeReq: "硕士" });
    const officialOnly = noticeToListings({ ...ex, publisherType: "企业官方", positions: [] }, "https://x.com/n", "capture");
    expect(officialOnly).toHaveLength(1);
    expect(officialOnly[0]).toMatchObject({ grade: "官方", isOriginal: true, title: "示例研究院 秋招" });
  });
});
