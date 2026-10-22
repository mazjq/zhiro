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
  const d: InboxDeps = { domain, vault, llm, auto: false }; // the decision as a confirm card; filing on its own is tested apart
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

  it("two applications at one company: a test without a job title is about the one already sent (B2); with both sent it is left for the user, candidates kept", async () => {
    const { domain, d, control } = setup({ 笔试通知: { category: "笔试", position: "" }, 第二次笔试: { category: "笔试", position: "" }, 嵌入式笔试: { category: "笔试", position: "嵌入式软件工程师" } });
    const embedded = domain.createApplication(domain.listPositions({ query: "嵌入式" }).items[0].id);
    // one sent, one still being prepared: a written test can only be about the sent one
    expect((await ingestMessage(d, "a", mail("笔试通知"))).message.applicationId).toBe(control.id);
    expect((await ingestMessage(d, "a", mail("嵌入式笔试安排"))).message.applicationId).toBe(embedded.id);
    // both sent and no title: the user places it; the candidates are kept
    domain.updateApplication({ id: embedded.id, state: "submitted" });
    const vague = await ingestMessage(d, "a", mail("第二次笔试"));
    expect(vague.message).toMatchObject({ applicationId: null, proposalId: null, status: "unlinked" });
    expect(new Set(vague.message.candidates)).toEqual(new Set([control.id, embedded.id]));
    expect(linkMessage(d, vague.message.id, embedded.id).message).toMatchObject({ applicationId: embedded.id });
  });

  it("a company written differently is found by a close name only when the job title agrees too (B4)", async () => {
    const { domain, d, control } = setup({ 资格审查: { category: "通过", company: "中国武汉华中数控集团有限公司", position: "运动控制算法工程师" }, 无岗位: { category: "通过", company: "中国武汉华中数控集团有限公司", position: "" } });
    expect((await ingestMessage(d, "a", mail("资格审查通过"))).message.applicationId).toBe(control.id);
    expect((await ingestMessage(d, "a", mail("无岗位通知"))).message).toMatchObject({ applicationId: null, candidates: [control.id] });
    void domain;
  });

  it("a mail is kept before it is classified: no model, it waits; the next pull classifies it (B30)", async () => {
    const { domain, d } = setup({ 一面邀请: { category: "面试", round: "一面" } });
    const llm = d.llm;
    d.llm = undefined;
    await expect(ingestMessage(d, "a", mail("一面邀请"))).rejects.toMatchObject({ code: "NO_MODEL" });
    expect(listMessages(domain.db, { includeOther: true }).items.map((m) => m.status)).toEqual(["unclassified"]);
    d.llm = llm;
    await pullAll(d, async () => []);
    expect(listMessages(domain.db).items[0]).toMatchObject({ category: "面试", status: "proposed" });
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

describe("the mail poll after every mailbox was disconnected and one is connected again (B26)", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { openDb } = await import("../db.js");
  const { Domain } = await import("./domain.js");
  const { WorkflowEngine } = await import("./workflow.js");
  const { inboxPoll, scheduleInbox } = await import("../workflows/inbox.js");
  it("runs again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zhiro-b26-"));
    const db = openDb(join(dir, "t.db"));
    const workflows = new WorkflowEngine(db);
    const s: any = { domain: new Domain(db), workflows, config: { vault: dir, feishu: {}, reminders: { daysBefore: [] }, sources: [] } };
    workflows.register(inboxPoll(s));
    workflows.start("inbox_poll", "inbox", "inbox_poll:inbox");
    await workflows.tick(); // no mailbox: the poll ends
    expect((db.prepare("select state from workflow where kind = 'inbox_poll'").get() as any).state).toBe("completed");
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(join(dir, "config", "mail.json"), JSON.stringify([{ id: "163:a@163.com", provider: "163", email: "a@163.com", authCode: "x", addedAt: "" }]));
    scheduleInbox(s);
    expect((db.prepare("select state from workflow where kind = 'inbox_poll'").get() as any).state).toBe("running");
  });
});

describe("inbox: the same employer written another way", () => {
  it("「DJI 大疆」 is 「大疆创新」; a mail placed by hand teaches the name", async () => {
    const { domain, d } = setup({ 大疆笔试: { category: "笔试", company: "DJI 大疆", position: "" }, 新写法: { category: "测评", company: "Hznc HR", position: "" } });
    const L = (title: string, id: string) => ({ externalId: id, url: "https://e.com", title, company: "深圳市大疆创新科技有限公司", locations: ["深圳"], publisher: "大疆", grade: "官方" as const, isOriginal: true, confidence: 1 });
    const { ingest } = await import("../data/index.js");
    ingest(domain, d.vault, "moka", "dji", [L("控制算法工程师", "d1"), L("数字管理研发工程师", "d2")]);
    const dji = (t: string) => domain.listPositions({ query: t, limit: 50 } as any).items.find((p: any) => /大疆/.test(p.companyName ?? ""))!.id;
    const ctrl = domain.createApplication(dji("控制算法工程师"));
    domain.updateApplication({ id: ctrl.id, state: "submitted" });
    domain.createApplication(dji("数字管理")); // a draft at the same company
    expect((await ingestMessage(d, "a", mail("大疆笔试邀请"))).message.applicationId).toBe(ctrl.id);
    // a way of writing nothing recognises: placed by hand, then learnt
    const first = await ingestMessage(d, "a", mail("新写法测评"));
    expect(first.message.applicationId).toBeNull();
    const hz = listMessages(domain.db).items.find((m) => m.subject === "新写法测评")!;
    const control = (domain.db.prepare("select a.id from application a join position p on p.id = a.position_id where p.title = '运动控制算法工程师'").get() as any).id;
    linkMessage(d, hz.id, control);
    expect((await ingestMessage(d, "a", mail("新写法测评二", "另一封"))).message.applicationId).toBe(control);
  });
});

describe("inbox: review fixes (PR #28)", () => {
  it("a mail that names a job none of them is is left for the user, not put under the one sent", async () => {
    const { domain, d } = setup({ 审计笔试: { category: "笔试", position: "财务审计专员" } });
    domain.createApplication(domain.listPositions({ query: "嵌入式" }).items[0].id); // a draft beside the sent one
    expect((await ingestMessage(d, "a", mail("审计笔试通知"))).message).toMatchObject({ applicationId: null, status: "unlinked" });
  });
  it("a classification that fails after asking the model waits longer each time; the others are not held up", async () => {
    const { domain, d } = setup({});
    d.llm = { model: () => ({ input: ["text"] }), models: { completeSimple: async () => { throw new Error("upstream 500"); } } } as any;
    await expect(ingestMessage(d, "a", mail("一面邀请"))).rejects.toThrow("upstream 500");
    const r = domain.db.prepare("select status, classify_attempts, classify_next_at from message").get() as any;
    expect(r).toMatchObject({ status: "unclassified", classify_attempts: 1 });
    expect(Date.parse(r.classify_next_at)).toBeGreaterThan(Date.now() + 60_000);
    const { classifyWaiting } = await import("./inbox.js");
    expect((await classifyWaiting(d)).done).toBe(0); // not its turn yet
  });
});

describe("inbox: clear mail is filed on its own (P2b)", () => {
  it("a dated test invitation becomes a stage at once, is in the history, can be undone; a vague one still asks", async () => {
    const { domain, d, control } = setup({ 笔试邀请: { category: "笔试", scheduledAt: "2026-10-25T19:00:00+08:00" }, 笔试无时间: { category: "笔试" } });
    d.auto = true;
    const r = await ingestMessage(d, "a", mail("笔试邀请"));
    expect(r.message).toMatchObject({ status: "filed", proposalId: null, applicationId: control.id });
    expect(domain.timeline(control.id).stages.map((s: any) => s.kind)).toEqual(["笔试"]);
    expect(domain.getApplication(control.id).state).toBe("in_process");
    const act = domain.db.prepare("select actor, undo_json from agent_action").get() as any;
    expect(act.actor).toBe("system:inbox");
    expect(JSON.parse(act.undo_json)).toEqual({ name: "inbox.unfile", input: { id: r.message.id } });
    // a test without a time is not filed blindly
    expect((await ingestMessage(d, "a", mail("笔试无时间通知"))).message.status).toBe("proposed");
    // undone: the stage gone, the application as it was
    const { unfileMail } = await import("./inbox.js");
    unfileMail(d, r.message.id);
    expect(domain.timeline(control.id).stages).toHaveLength(0);
    expect(domain.getApplication(control.id).state).toBe("submitted");
  });
  it("an undo never overwrites what the person changed afterwards", async () => {
    const { domain, d, control } = setup({ 拒信: { category: "拒信" } });
    d.auto = true;
    const r = await ingestMessage(d, "a", mail("拒信通知"));
    expect(domain.getApplication(control.id).state).toBe("closed");
    await new Promise((x) => setTimeout(x, 5));
    domain.updateApplication({ id: control.id, nextAction: "问问 HR 原因" });
    const { unfileMail } = await import("./inbox.js");
    expect(() => unfileMail(d, r.message.id)).toThrow(/改过/);
  });
  it("a pass with no stage waiting is progress: sent becomes in process, the note is kept", async () => {
    const { domain, d, control } = setup({ 资格审查通过: { category: "通过", summary: "已通过资格审查" } });
    d.auto = true;
    await ingestMessage(d, "a", mail("资格审查通过"));
    expect(domain.getApplication(control.id).state).toBe("in_process");
    expect(domain.timeline(control.id).events.some((e: any) => e.detail.includes("收到通过通知"))).toBe(true);
  });
  it("unsure classifications still ask", async () => {
    const { d } = setup({ 面试: { category: "面试", scheduledAt: "2026-10-25T10:00:00+08:00", confidence: 0.5 } as any });
    d.auto = true;
    expect((await ingestMessage(d, "a", mail("面试安排"))).message.status).toBe("proposed");
  });
});

describe("inbox: undoing what mail filed (P2b review)", () => {
  it("two filings of one application undo newest first; the history says undone; the notice not yet sent is withdrawn", async () => {
    const { domain, d, control } = setup({ 一面邀请: { category: "面试", round: "一面", scheduledAt: "2026-10-25T10:00:00+08:00" }, 一面改期: { category: "面试改期", round: "一面", scheduledAt: "2026-10-26T15:00:00+08:00" } });
    d.auto = true;
    const a = await ingestMessage(d, "a", mail("一面邀请"));
    const b = await ingestMessage(d, "a", mail("一面改期通知"));
    expect(b.message.status).toBe("filed");
    expect(domain.timeline(control.id).stages[0].scheduledAt).toBe("2026-10-26T15:00:00+08:00");
    const { unfileMail } = await import("./inbox.js");
    unfileMail(d, b.message.id);
    expect(domain.timeline(control.id).stages[0].scheduledAt).toBe("2026-10-25T10:00:00+08:00");
    unfileMail(d, a.message.id); // the earlier one, after the later one was undone
    expect(domain.timeline(control.id).stages).toHaveLength(0);
    expect((domain.db.prepare("select count(*) as n from agent_action where undone_at is null").get() as any).n).toBe(0);
    expect((domain.db.prepare("select count(*) as n from notice where key like 'filed:%' and state = 'pending'").get() as any).n).toBe(0);
  });
  it("a stage the person changed after it was filed is not touched by an undo", async () => {
    const { domain, d, control } = setup({ 笔试邀请: { category: "笔试", scheduledAt: "2026-10-25T19:00:00+08:00" } });
    d.auto = true;
    const r = await ingestMessage(d, "a", mail("笔试邀请"));
    const st = domain.timeline(control.id).stages[0];
    domain.updateStage({ id: st.id, notes: "带身份证" });
    const { unfileMail } = await import("./inbox.js");
    expect(() => unfileMail(d, r.message.id)).toThrow(/改过/);
    expect(domain.timeline(control.id).stages).toHaveLength(1);
  });
});
