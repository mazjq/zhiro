import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.js";
import { Domain } from "./domain.js";
import { ingest } from "../data/index.js";
import { connectAccount, loadAccounts, publicAccount, looksLikeRecruiting, appliedCompanyKeys, pullAll, ingestMessage, listMessages, listSkipped, rescueSkipped, linkMessage, readMessage, type RawMail, type InboxDeps, type MailFetcher } from "./inbox.js";

type Reply = { category: string; round?: string; company?: string; position?: string; scheduledAt?: string | null; link?: string; summary?: string };

/** The fake model answers by the first reply key found in the mail, so every test mail classifies deterministically. */
function setup(replies: Record<string, Reply>) {
  const vault = mkdtempSync(join(tmpdir(), "jobos-inbox-"));
  const domain = new Domain(openDb(join(vault, "t.db")));
  let calls = 0;
  const llm: any = { model: () => ({ input: ["text"] }), models: { completeSimple: async (_m: unknown, ctx: any) => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    const text: string = ctx.messages[0].content[0].text;
    const key = Object.keys(replies).find((k) => text.includes(k));
    const r = key ? replies[key] : { category: "其他" };
    return { content: [{ type: "text", text: JSON.stringify({ round: "", company: "华中数控", position: "", scheduledAt: null, link: "", summary: key ?? "", confidence: 0.9, ...r }) }] };
  } } };
  const d: InboxDeps = { domain, vault, llm };
  const L = (title: string, id: string) => ({ externalId: id, url: "https://e.com", title, company: "武汉华中数控股份有限公司", locations: ["武汉"], publisher: "华中数控", grade: "官方" as const, isOriginal: true, confidence: 1 });
  ingest(domain, vault, "moka", "x", [L("运动控制算法工程师", "1"), L("嵌入式软件工程师", "2")]);
  const control = domain.createApplication(domain.listPositions({ query: "运动控制" }).items[0].id);
  domain.updateApplication({ id: control.id, state: "submitted" });
  return { vault, domain, d, control, calls: () => calls };
}
const mail = (subject: string, text = "正文", extra: Partial<RawMail> = {}): RawMail => ({ messageId: `<${subject}@t>`, from: "HR <hr@hznc.example>", subject, date: "2026-09-19T02:00:00.000Z", text, ...extra });
const proposals = (domain: Domain) => domain.listProposals().map((p) => ({ ...(p.payload as any), tool: p.kind }));

describe("inbox: nothing is silently lost", () => {
  it("the filter passes keywords, ATS senders and any company you applied to; what it skips is logged by subject and can be rescued", async () => {
    const { vault, domain, d } = setup({ 下周安排: { category: "面试", round: "二面", scheduledAt: "2026-09-28T10:00:00+08:00" }, 账单: { category: "其他" } });
    const applied = appliedCompanyKeys(domain.db);
    expect(looksLikeRecruiting(mail("【华中数控】笔试邀请"))).toBe(true);
    expect(looksLikeRecruiting({ from: "no-reply@mail.mokahr.com", subject: "您有一条新消息", text: "点击查看" })).toBe(true);
    expect(looksLikeRecruiting({ from: "王老师 <wang@hznc.example>", subject: "关于下周安排", text: "华中数控这边想和你约个时间" }, applied)).toBe(true);
    expect(looksLikeRecruiting({ from: "bank@x.com", subject: "信用卡账单", text: "本期应还 100 元" }, applied)).toBe(false);

    const box: RawMail[] = [mail("关于下周安排", "华中数控这边想和你约个时间"), { messageId: "<bill>", from: "bank@x.com", subject: "信用卡账单", date: "2026-09-19T01:00:00.000Z", text: "本期应还" }];
    const fetcher: MailFetcher = async (_a, _s, opts) => (opts?.messageId ? box.filter((m) => m.messageId === opts.messageId) : box);
    await connectAccount(vault, { provider: "163", email: "me@163.com", authCode: "SECRET" }, fetcher);
    expect(await pullAll(d, fetcher)).toMatchObject({ fetched: 2, recruiting: 1, added: 1, skipped: 1, errors: [] });
    expect(listSkipped(domain.db).items.map((x) => x.subject)).toEqual(["信用卡账单"]);
    // second pull: nothing new, nothing re-logged
    expect(await pullAll(d, fetcher)).toMatchObject({ added: 0, skipped: 0 });
    // the user decides the skipped one matters after all
    expect((await rescueSkipped(d, fetcher, "163:me@163.com", "<bill>")).added).toBe(true);
    expect(listSkipped(domain.db).items).toHaveLength(0);
  });

  it("the auth code is checked before it is saved and never comes back out", async () => {
    const { vault } = setup({});
    await expect(connectAccount(vault, { provider: "163", email: "me@163.com", authCode: "wrong" }, async () => { throw new Error("LOGIN Unsafe Login"); })).rejects.toMatchObject({ code: "LOGIN_FAILED" });
    expect(loadAccounts(vault)).toHaveLength(0);
    const acc = await connectAccount(vault, { provider: "qq", email: "me@qq.com", authCode: "SECRET" }, async () => []);
    expect(JSON.stringify([acc, loadAccounts(vault).map(publicAccount)])).not.toContain("SECRET");
  });
});

describe("inbox: no duplicates", () => {
  it("the same mail pulled twice, pasted as text, or pulled by two runs at once is stored and proposed once", async () => {
    const { vault, domain, d, calls } = setup({ 一面邀请: { category: "面试", round: "一面", scheduledAt: "2026-09-25T14:00:00+08:00" } });
    const m = mail("一面邀请", "请于 9 月 25 日 14:00 参加一面");
    const fetcher: MailFetcher = async () => [m];
    await connectAccount(vault, { provider: "163", email: "me@163.com", authCode: "x" }, fetcher);
    const [a, b] = await Promise.all([pullAll(d, fetcher), pullAll(d, fetcher)]); // timer + "立即收取" at the same moment
    expect(a).toBe(b);
    expect(calls()).toBe(1);
    // the user also pastes the same text from their phone: different id, same content
    expect((await ingestMessage(d, "paste", { ...m, messageId: "paste:abc", from: "粘贴" })).added).toBe(false);
    expect(listMessages(domain.db).items).toHaveLength(1);
    expect(proposals(domain)).toHaveLength(1);
  });

  it("a reminder about an interview already on record proposes nothing and says why", async () => {
    const { domain, d, control } = setup({ 一面邀请: { category: "面试", round: "一面", scheduledAt: "2026-09-25T14:00:00+08:00" }, 面试提醒: { category: "面试", round: "一面", scheduledAt: "2026-09-25T14:00:00+08:00" } });
    await ingestMessage(d, "a", mail("一面邀请"));
    const stillPending = await ingestMessage(d, "a", mail("面试提醒：明天 14:00"));
    expect(stillPending.message).toMatchObject({ proposalId: null });
    expect(stillPending.message.note).toContain("待你确认");
    domain.addStage({ applicationId: control.id, kind: "一面", scheduledAt: "2026-09-25T14:00:00+08:00" });
    const onRecord = await ingestMessage(d, "a", mail("面试提醒：还有 1 小时", "一面即将开始"));
    expect(onRecord.message.note).toContain("同一件事");
    expect(proposals(domain)).toHaveLength(1);
  });
});

describe("inbox: every kind of notice maps to the right change", () => {
  it("rounds become distinct stages; reschedule, pass and cancel update the stage they are about", async () => {
    const { domain, d, control } = setup({
      二面邀请: { category: "面试", round: "二面", scheduledAt: "2026-09-30T10:00:00+08:00", link: "https://vc.example/2" },
      改期: { category: "面试改期", round: "一面", scheduledAt: "2026-09-26T16:00:00+08:00" },
      恭喜通过: { category: "通过", round: "一面" },
      取消: { category: "面试取消", round: "二面" },
    });
    const first = domain.addStage({ applicationId: control.id, kind: "一面", scheduledAt: "2026-09-25T14:00:00+08:00" });
    await ingestMessage(d, "a", mail("面试改期通知"));
    await ingestMessage(d, "a", mail("恭喜通过一面"));
    await ingestMessage(d, "a", mail("二面邀请"));
    expect(proposals(domain)).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: "stage.update", id: first.id, scheduledAt: "2026-09-26T16:00:00+08:00" }),
      expect.objectContaining({ tool: "stage.update", id: first.id, result: "通过" }),
      expect.objectContaining({ tool: "stage.add", applicationId: control.id, kind: "二面", scheduledAt: "2026-09-30T10:00:00+08:00", link: "https://vc.example/2" }),
    ]));
    expect(proposals(domain)).toHaveLength(3);
    // approve the reschedule the way the UI does; the stage moves, the timeline says so
    const p = domain.listProposals().find((x) => (x.payload as any).scheduledAt === "2026-09-26T16:00:00+08:00")!;
    domain.decideProposal(p.id, "approved", p.payloadHash, (_k, payload) => domain.updateStage(payload));
    expect(domain.timeline(control.id).stages[0].scheduledAt).toBe("2026-09-26T16:00:00+08:00");
    // a cancellation for a round that is not on record changes nothing
    expect((await ingestMessage(d, "a", mail("二面取消"))).message.note).toContain("没有对应");
  });

  it("rejection, confirmation, to-do and junk-folder origin", async () => {
    const { domain, d, control } = setup({
      很遗憾: { category: "拒信" }, 投递成功: { category: "投递确认" },
      补充材料: { category: "待办", scheduledAt: "2026-09-22T23:59:00+08:00", summary: "9月22日前上传成绩单" }, 宣讲会: { category: "其他" },
    });
    expect((await ingestMessage(d, "a", mail("投递成功"))).message.note).toContain("已经是已投递");
    await ingestMessage(d, "a", mail("请补充材料", "正文", { folder: "垃圾箱" }));
    await ingestMessage(d, "a", mail("很遗憾通知您"));
    await ingestMessage(d, "a", mail("宣讲会邀请"));
    expect(proposals(domain)).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: "application.update", id: control.id, nextAction: "9月22日前上传成绩单", nextActionAt: "2026-09-22T23:59:00+08:00" }),
      expect.objectContaining({ tool: "application.update", id: control.id, state: "closed", closeReason: "拒信" }),
    ]));
    expect(proposals(domain)).toHaveLength(2);
    const shown = listMessages(domain.db).items;
    expect(shown.map((m) => m.category)).not.toContain("其他");
    expect(shown.find((m) => m.subject === "请补充材料")!.folder).toBe("垃圾箱");
  });

  it("two applications at one company: a mail that does not name the job is left for the user to place", async () => {
    const { domain, d, control } = setup({ 笔试通知: { category: "笔试", position: "" }, 嵌入式笔试: { category: "笔试", position: "嵌入式软件工程师" } });
    const embedded = domain.createApplication(domain.listPositions({ query: "嵌入式" }).items[0].id);
    const vague = await ingestMessage(d, "a", mail("笔试通知"));
    expect(vague.message).toMatchObject({ applicationId: null, proposalId: null });
    expect((await ingestMessage(d, "a", mail("嵌入式笔试安排"))).message.applicationId).toBe(embedded.id);
    expect(linkMessage(d, vague.message.id, control.id).message.proposalId).toBeTruthy();
  });

  it("the original mail can be read back: text, HTML and the raw .eml", async () => {
    const { domain, d } = setup({ 一面邀请: { category: "面试", round: "一面" } });
    const r = await ingestMessage(d, "a", mail("一面邀请", "纯文本正文", { html: "<p>HTML <b>正文</b></p>", eml: Buffer.from("From: hr\r\n\r\nraw") }));
    const back = readMessage(domain.db, r.message.id);
    expect(back.body).toContain("纯文本正文");
    expect(back.html).toContain("<b>正文</b>");
    expect(back.emlPath).toMatch(/\.eml$/);
  });
});

describe("inbox: reminders with an unreliable date", () => {
  it("a late-pasted '今晚开始' reminder resolves to the wrong day but is still recognised by its link or its reminder flag", async () => {
    const { domain, d, control } = setup({
      今晚开始: { category: "笔试", scheduledAt: "2026-09-19T19:00:00+08:00", link: "https://exam.example/1", ...({ isReminder: true } as object) },
      还未完成: { category: "测评", scheduledAt: null, ...({ isReminder: true } as object) },
      offer: { category: "offer", scheduledAt: "2026-10-30T00:00:00+08:00" },
    });
    domain.addStage({ applicationId: control.id, kind: "笔试", scheduledAt: "2026-09-27T19:00:00+08:00", link: "https://exam.example/1" });
    domain.addStage({ applicationId: control.id, kind: "测评", scheduledAt: "2026-09-23T23:59:00+08:00" });
    expect((await ingestMessage(d, "a", mail("笔试今晚开始"))).message.note).toContain("同一件事");
    expect((await ingestMessage(d, "a", mail("您还未完成测评"))).message.note).toContain("提醒");
    expect(proposals(domain)).toHaveLength(0);
    // an offer's date is the deadline to answer, so it is not recorded as when the offer "happens"
    await ingestMessage(d, "a", mail("录用意向书 offer"));
    expect(proposals(domain)[0]).toMatchObject({ tool: "stage.add", kind: "offer" });
    expect(proposals(domain)[0].scheduledAt).toBeUndefined();
  });
});
