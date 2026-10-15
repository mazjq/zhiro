/**
 * 调研信源清单: where a person (or an agent) looking into an industry, a kind of job or a company would go, what each
 * place is good for, and how far to trust it. Handed to whoever does a 主题调研 as part of the brief. A list, not readers:
 * most of these have no stable interface, and reading them is the agent's job. The few that Zhiro reads itself are tools
 * (company.intel for a company's filings; industry.* once they exist) and are named as such.
 * Reachability noted as measured from the maintainer's network on 2026-10-13; elsewhere it differs.
 */
export const RESEARCH_SOURCES = `### 官方统计（最可信，更新慢）
- 中国国家统计局 data.stats.gov.cn：分行业就业人数、分行业平均工资（年度）。
- 人社部「最缺工的 100 个职业」排行（季度，mohrss.gov.cn）：哪些职业招不到人。
- 各地人社局「工资指导价位」：分职业的工资分位数（年度，按城市）。
- 美国劳工统计局 BLS：分职业的就业人数和年薪用数据工具 labor us 直接取（OEWS）；分行业就业（CES）、职业展望手册 OOH（未来十年各职业的增长预期，bls.gov/ooh）要自己读网页。
- 美国 WARN 裁员预告（各州劳工部门网站）：法定的大规模裁员公告。

### 公司层面（财报与公告是事实，研报是观点）
- 上市公司的行业、员工数、近三年营收 / 净利 / 研发：用数据工具 company financials 按名字或代码取，不要自己再去找财报。
- 公司官网的投资者关系页、年报（员工人数、研发投入、业务分部）。
- 巨潮资讯 cninfo.com.cn（A 股公告）；美国证监会 EDGAR sec.gov（美股申报文件；部分网络访问受限）。
- 券商行业研报：用数据工具 industry reports 列出（标题、机构、日期、评级、原文与 PDF 链接）。观点类，注明是哪家券商、哪天的；要读内容再打开链接。
- Alpha Vantage、雅虎财经（yfinance）、AKShare：你所在的环境里能用就可以用来取美股数据；用了要在信源里写明。

### 招聘市场与薪资（样本有偏，只作参考）
- 招聘平台的年度 / 季度报告：智联招聘、猎聘、BOSS 直聘研究院、脉脉人才报告（中国）；LinkedIn Economic Graph、Indeed Hiring Lab（美国及全球）。
- 薪资：levels.fyi（科技公司分职级薪酬，自报）；Glassdoor；中国的 OfferShow、牛客薪资贴（自报，样本小）。
- 裁员：layoffs.fyi（科技行业裁员汇总）；媒体报道。

### 行业动态（线索，不是事实）
- 华尔街见闻、财新、36 氪、行业协会网站与白皮书；高校就业质量报告（各校每年发布，有去向行业分布）。

用的时候：数字优先取官方统计和财报；平台报告和自报薪资要写明样本来源；研报和媒体的判断标为「行业线索」。`;
