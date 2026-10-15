# 读取器：加一个新站点或一种新表格

一个读取器 = 这个目录里的一个文件 + `index.ts` 登记表里的一行 + 一个同目录的测试。别处不用改：通道表、订阅列表、预览、接入、每日拉取、失败原因的显示都从登记表来。

适用范围：不需要登录、配置项不超出 `SourceConfig` 现有字段的读取器。要密钥或要新的配置界面，会碰到这个目录以外（工具契约、设置页），先开 issue 讨论。

## 1. 写读取器 `<站点>.ts`

```ts
import type { Listing, Source } from "../types.js";

export const acme: Source = {
  id: "acme",                                  // 存进订阅和数据库的名字，定了不要改
  name: "某某招聘站",                            // 给人看的
  input: "jobs.acme.com/<公司>",                // 链接长什么样，显示在「数据通道」里
  mode: "pull",
  describe: "一句话：读的是什么、怎么读的",
  detect: (url) => /^https:\/\/jobs\.acme\.com\//.test(url),   // 这个链接归不归我
  siteKey: (url) => new URL(url).pathname.split("/")[1],        // 同一个站的不同页面给同一个值：一个站只订阅一次
  async fetch(cfg, ctx) {                      // 读全部在招岗位，返回 Listing[]
    const data: any = await ctx.fetchJson(`https://jobs.acme.com/api/${...}`);
    return data.items.map((j: any): Listing => ({
      externalId: String(j.id),                // 站点自己的岗位编号；没有就别编，用链接
      url: j.url, title: j.name, company: cfg.name ?? "", locations: j.cities ?? [],
      description: j.jd, degreeReq: j.degree, validThrough: j.endDate,
      cohort: cfg.cohort, batch: cfg.batch ?? "校招", kind: "校招",
      publisher: `acme:${...}`, grade: "官方", isOriginal: true, confidence: 0.9,
    }));
  },
};
```

要点：

- **字段**照 `../types.ts` 的 `Listing`（名字跟 schema.org/JobPosting 走）。读不到的字段不填，不要猜。
- **`externalId`** 用站点自己的岗位编号。同名岗位在三个城市各一条、编号不同，就是三个岗位。
- **`grade`**：公司自己的招聘站是「官方」；转载、汇总一律不是。
- **读不成就抛错，带原因码**：`throw new Error("SCHEMA_CHANGED: 岗位接口返回异常")`。原因码见 `../sync.ts` 的 `SYNC_REASONS`（超时、要登录、被拦、改版、零岗位…）。不带码的报错会按文字归类，归不上就显示「读取失败」。
- **读到零个岗位**不要自己处理：返回空数组，上层会记为失败并且不关已有岗位。
- 用 `ctx.fetchJson / fetchText`（带超时和 UA）；翻页之间 `await ctx.sleep(...)`，别打太快。
- 两个可选声明：`aggregate: true`（读的是别人转录的汇总表，不算官方，行没有岗位编号）；`notices: true`（读的是集团公告里的岗位清单，没有逐岗位的详情页）。

**表格类**的读取器不写 `fetch` 的转换逻辑，只把表交出来：

```ts
async table(cfg, ctx) { return { headers: [...], rows: [{ id: "", get: (列名) => "单元格文字" }] }; },
async fetch(cfg, ctx) { return listingsFromTable(await this.table!(cfg, ctx), cfg, "某某表格"); },
```

哪一列读成什么由订阅里存的列对应决定（`../sheet.ts`）。参考 `csv.ts`（52 行）和 `feishu-base.ts`。

## 2. 登记 `index.ts`

`import { acme } from "./acme.js";`，加进 `sources` 那个数组。

## 3. 测试 `<站点>.test.ts`

把接口返回的一段真实数据（去掉个人信息）贴进测试，断言转换结果；再断言 `detect` 认哪些链接、不认哪些，`siteKey` 对同一个站的两个页面相同。参考 `portals.test.ts`、`csv.test.ts`。

## 4. 自己验一下

```bash
pnpm --filter @zhiro/daemon data probe <真实链接>     # 不写库，看读出来是什么
pnpm --filter @zhiro/daemon test:data                # 只跑数据层的测试
```

`test:data` 里的 `boundary.test.ts` 会拦住一件事：这个目录里的代码不能引用数据层以外的东西（工具、agent、模型、界面）。
