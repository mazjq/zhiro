# Design decisions

The decisions that still shape the code, each with the reason. New ones are appended at the end (`D-<n> · date · title`,
then what was decided and why). The project's history before it went public is not part of this repository; these
entries condense what still holds.

## Trust and permissions

- **D-1 · The person decides anything irreversible.** Nothing submits an application, sends a message or deletes the
  person's data by itself. Form filling stops before *Submit*; inbox mail only produces suggestions.
  *Why:* a wrong application or message cannot be taken back; being slower is cheaper than being wrong.
- **D-2 · One entry point, permissions decided there.** Every caller goes through `callTool`; an agent's writes are
  *done undoably*, *asked first* (a confirm card), or *refused* (logins, credentials). *Why:* the same rules hold for
  the UI, MCP, HTTP and every harness, with no side door.
- **D-3 · Identity comes from the key.** Four keys (person, agent, per-turn, bookmarklet); `x-jobos-actor` is only an
  audit label. *Why:* an agent saying "I am the user" must not make it the user.
- **D-4 · A confirm card counts as approved only when its work is done.** A card whose work was running when the
  daemon stopped is shown as interrupted and never re-run by itself.
- **D-5 · Agents may confirm and undo their own cards in the person's own agent** (after the person says yes, within
  30 minutes); this can be limited to the Zhiro window.

## The person's own agent

- **D-6 · Zhiro is a set of tools any agent can use.** The person picks the harness (Claude Code, Codex, WorkBuddy, an
  ACP agent, or the optional built-in assistant); the model is whatever that harness is set to. Business state lives
  only in the data folder, never in a harness's memory. *Why:* switching harness loses nothing.
- **D-7 · Whoever starts model work does it.** Work an external agent starts (matching, research, mail sorting) goes
  back to that agent; Zhiro does not call another model behind its back. Background tidying may use the built-in model
  to save the agent's tokens (on by default, can be turned off).
- **D-8 · One MCP implementation, in the daemon** (`/mcp`); `zhiro mcp` only relays.
- **D-9 · The agent directory** (`<data>/agent`) holds each harness's project-level config and the skill; nothing is
  written into anyone's global settings.

## Data

- **D-10 · Local first, one data folder, one writer.** SQLite through Node's built-in `node:sqlite` (no native module);
  an exclusive lock per folder. *Why:* one install step, nothing to compile, no lost updates.
- **D-11 · Tools built in, data not.** Lists of companies, links to anyone's spreadsheets, profiles: the person's own
  data, never shipped in the repository.
- **D-12 · Readers follow schema.org/JobPosting fields and the career-ops provider shape.** A new site is one file, one
  registry line and one test in `data/readers/`.
- **D-13 · Sources do not overwrite each other.** Each source's statement is kept with its grade (official vs
  aggregated); reading merges them by grade. Deadlines are resolved in one place (facts → resolution → wording).
- **D-14 · Sheets are subscriptions with a column mapping stored in the subscription**, previewed before they are
  saved; a local file is handed over by the person, never picked by an agent without a confirm card.
- **D-15 · A subscription that exists is always pulled**; failures are retried on schedule and shown, not silently
  dropped.
- **D-16 · Ingest is incremental**: unchanged rows are only marked as seen; an unchanged table is not snapshotted again.

## Upgrades and installs

- **D-17 · Upgrades run on a copy.** The original database is never migrated in place; the copy is checked (row
  counts, the person's rows, structure, integrity) before it replaces anything, and the original is kept with a
  manifest. `verify` and `rollback` are commands. Every schema ships a synthetic sample the next release must upgrade.
- **D-18 · One answer for where the data is** (`--data`, `ZHIRO_DATA`, the remembered choice, the old JobOS place,
  the platform default); a place that should hold data but cannot be reached stops the start rather than opening an
  empty folder elsewhere.
- **D-19 · The data folder can move to another disk**: copied, every file compared, switched only when all match; the
  old path stays as a link so stored paths keep working.
- **D-20 · Ship built JavaScript, one `zhiro` command**; `paths.ts` is the only code that knows where the program's
  own files are.
- **D-21 · The rename to Zhiro changed names people see**, not names in the data (`jobos.db`, `config/jobos.yaml`,
  key files, `x-jobos-*` headers) — renaming those would risk data for nothing.

## Agent token use

- **D-22 · 2026-10-15 · List tools have a short form, asked for explicitly.** `position.list`, `application.list` and
  `pool.list` take `detail: "brief"`: no job descriptions or other long texts; a deadline keeps what a decision needs
  (`closesAt`, `deadlineKind`, `expired` — `null` when unknown, never `false` — `status`, `say`); `pool.list` pages by 20 companies
  and lists every post whose title has the search words (the search reads company names and post titles, not
  descriptions) and every post the profile matched (`matchedPositions` with `matchedBy`, compact, up to 50 a company —
  `positionsLimit` raises it for one company), the others by count. Leaving `detail` out returns exactly what it always did — agents in
  the wild depend on it; Zhiro's own skill, chat-drawer rules and built-in assistant ask for the short form and tell
  the agent to page while `hasMore`. *Why:* measured on a real database, one `pool.list` was about a million tokens
  (every company carried all its posts). *Not at the cost of finding things:* on 12 real queries, the short form
  followed as the skill says (pages, then `positionsLimit` for a company with `matchedHasMore`) reached 100% of the
  companies and matched posts of the full result, with 5–30% of its tokens; deadlines agreed in every case. A first
  version showing 3 previews per company reached only 8–56% of the matched posts and was dropped. With Claude Code
  answering 8 questions twice each (before vs after, the same copy): 12/16 right vs 8/16, list recall 100% vs 85%,
  precision 95% vs 79%, 3.5 vs 8.1 tool calls, about 290,000 vs 890,000 input tokens — no question did worse. New fields have new
  names: an old name never changes meaning.
- **D-23 · 2026-10-15 · One copy of each result, for a connection that asks.** By default a tool result carries the
  JSON both as text and as `structuredContent` (what MCP asks for). Claude Code gives its model the structured copy
  only; Codex gives it both (measured with differing markers), which roughly doubles every result. A connection with
  header `x-zhiro-result-mode: text` — set by the stdio relay from `ZHIRO_RESULT_MODE=text`, which Zhiro writes into
  its Codex configs — gets the text copy only. Not the structured copy only: given `content: []`, Codex's model took
  the result for empty in three runs of four, while text-only was read right every time. Never inferred from a
  client's name or the audit label.
- **D-24 · 2026-10-15 · The model for Claude Code / Codex is picked from the harness's own list.** By default Zhiro
  follows the model set inside the harness (unchanged). The settings page can pick another one for Zhiro's runs only:
  the choices are read from the list the installed harness keeps itself (Claude Code's model catalog cache, Codex's
  `models_cache.json`), newest first, so the person never types a model name. Kept in `agent.models` of the config;
  the harness's own settings are never written. A pick the installed command line refuses falls back to its default,
  as before, and the page says so. The built-in model is drawn inside the same card, only when it serves something
  (内置助手 chosen, or background tidying on it).
- **D-25 · 2026-10-17 · 高校人才网 as a subscription: a reprint, read whole each time.** Research institutes, labs,
  university teams, 事业单位 and small firms rarely post on a hiring system, so the hiring-system readers never see them;
  高校人才网 collects their notices by city and kind. One subscription is one column (`siteKey` = column id). Its mobile
  list needs no login (desktop paging does); each announcement's desktop page gives the dates, deadline text, body and
  the original notice, and its job list gives jobs with the site's own ids. Because a read that leaves a post out closes
  it, each read returns the whole set still open by a fixed rule — a stated date not passed; 长期有效 / 招满 posted within
  180 days; anything else within 90 — and a read that hits the page cap first fails instead of returning half. Only a
  whole date becomes a deadline; 「详见正文」「11月30日」 stay as text (shown 待核实). Every post is 聚合, `isOriginal`
  false, confidence 0.7 (official readers give 0.85–0.9). Not `notices`: each job has its own id and page, and marking
  it would queue every such company for the daily model-paid lead resolution. Pages are 0.6–1.4 s apart; a column of
  ~110 open announcements takes about nine minutes.
- **[已被 D-31 取代] D-26 · 2026-10-18 · BOSS 直聘 is searched by the person's own agent in the person's own browser, not crawled.** A
  headless browser was flagged by BOSS on its first search (2026-10-16, 「您的环境存在异常」). Searching in the person's
  real, logged-in, visible browser with page loads 5–12 s apart did not trip it (2026-10-18, one search page and two
  job pages). So Zhiro ships no BOSS reader; the agent skill (`agent-skills/zhiro`) carries the protocol: city home page
  first, then the search URL; a page budget per session and per day; list pages first, details only for picks; dedupe
  against the pool; file picks with `listing.capture` (publisher `boss`); stop on any verification or login page; never
  press 沟通 / 投递. One quiet run is evidence, not a guarantee; the protocol keeps the volume low and stops early.
- **[已被 D-31 取代] D-27 · 2026-10-18 · BOSS visits: a budget and a circuit breaker held by Zhiro, not a rule the agent remembers.**
  D-26 put the BOSS rules in the skill; a rule in a document is forgotten at the next handoff. Now every page the agent
  opens needs a one-time permit (`boss.permit`): it names the one page, the earliest moment to open it (a person-like
  pause by what came before: 4–10 s after the city page, 8–30 s from a list to a job, 12–45 s between jobs, now and then
  a minute or two more, 20–60 min between sessions) and expires five minutes later. The page is handed back with what
  it says (`boss.page`). A session starts on a city page; jobs come after a search; at most 4 sessions a day and 1 / 5 /
  15 home / search / job pages a session, half of that for the first 3 days and after any stop (`jobos.yaml` → `boss`).
  A check by BOSS (a redirect to a check or a login, a check at the top of the page, an empty page) stops visits for
  24 hours; only the person lifts it. A job page is read by blocks and only the post is kept — title, pay, place,
  days, months, degree, description, the registered company name, the address — filed as a 聚合 post under its BOSS
  job id; nothing of the person's own block is stored or returned. A page missing a block is a preview that the agent
  may complete with values found on that same page. An agent's `listing.capture` of a BOSS link is refused. What
  Zhiro cannot see — whether the agent waited and which browser it used — stays a rule of the skill, and the page says
  so. Advised by Codex (2026-10-18); the budget is the person's call (the review advised less).
- **[已被 D-31 取代] D-28 · 2026-10-18 · BOSS: Zhiro drives a dedicated Chrome and listens to the page's own job data.** D-27 had the
  agent open every page and hand its text back; it cost tokens per page and was slower than a person. Now the person
  starts a normal Chrome with its own profile (`<vault>/boss-chrome`; Chrome 136+ will not open the everyday profile
  for debugging) and a debugging port (9333), and logs in to BOSS once. Zhiro attaches over CDP, opens the home page at
  the start of a session, then the search URL, scrolls down the list in uneven steps (now and then back up) and waits
  for the page's own `joblist.json` (a POST; query, city and page are in its body). It never sends a request of its own
  (a scripted request is what BOSS flags, code 37). Search results are kept as candidates (`boss_candidate`), not
  posts; `boss.detail` opens a picked job page, reads the server-rendered blocks (description, pay, address, the
  registered name under 工商信息) and files it as a 聚合 post under its BOSS job id. A check or login page, or a
  code-37 / 异常 / 验证 answer, stops visits for 24 hours as in D-27; the person-only lift stays. The default budget is
  6 sessions a day, 10 search screens and 20 job pages a session (half for the first 3 days), the person's call. Tried on
  2026-10-18: two screens (30 posts) in 26 s, one job page in 5 s, no check. Approach from open-source BOSS readers that
  attach to a logged-in browser (e.g. boss-zhipin-scraper, MIT); no code taken.
- **D-29 · 2026-10-18 · Comparing employers: places in the industry and under preferences, no total score.** The
  person asked which employers are most worth joining and for sound methods. Each listed company is placed among all
  A-share companies of its 申万一级 industry (a dated snapshot of 东方财富 F10 company list, income and cash-flow
  statements, kept a week in `peer_snapshot`, like a name looked up on the other boards) on four measures, one per aspect: growth (three-year revenue CAGR), R&D
  (R&D ÷ revenue), a pay signal (cash paid to staff ÷ latest staff count; rough) and profit (net margin). Among the
  companies asked about, places are given under three open preferences (成长研发优先 / 均衡 / 稳定回报优先) or the
  person's own weights, with the usual range (10th–90th) and the share of top-three places over weights drawn evenly
  within ±0.1 of them (fixed seed), plus the share over every weighting. A company that does no better than another on
  all four is named as such; that is a screen, not a tier. A missing measure is not filled in: the company gets its
  place by what is known and the best and worst it could be. What changed together in the year is said as that, never
  as a cause. Labels are plain rules on the percentiles. Hong Kong, US, 新三板 and unlisted companies are not ranked
  with them. Left out after review (Codex, 2026-10-18): AHP (the person would compare pairs of abstract aspects),
  grey relational analysis and TOPSIS (unstable with a handful of companies), Ward clustering, fuzzy evaluation, and a
  model playing the expert.
  An employer report (`research.company` with question 就业评估) starts with a fact table Zhiro writes from the same
  snapshot (four years of revenue, profit, R&D, staff cash, dividend-and-interest cash, capex; the four places); the
  person's agent writes the rest — why profit moved (a cause only where the annual report or a notice says it), where
  the money went, whether incentive plans reach technical staff, listing or IPO progress across the three exchanges,
  job signals, and the match with the person, kept apart — and hands back each conclusion with its kind, sources, the
  counter-claims it looked for and its limits, shown as a table under the report.
  2026-10-19: a 新三板 company is compared too — its own industry scheme is not 申万, so it is measured against the
  A-share companies of its 证监会 industry, which both carry, and says so. (The first list also left out 北交所: its
  label is 「北京证券交易所A股」.) The report has a section on people — the person wants to know about layoffs, pay
  per head and size: the agent hands back year-end headcounts each with its source (annual report 员工情况; for an
  unlisted company the 社保参保人数 of its public annual filing, or a prospectus) and the layoff, pay-cut and
  unpaid-wage reports it found; Zhiro divides its own staff cash by those headcounts and states how headcount and pay
  per head moved. A Hong Kong or US listing is placed too, read one company at a time (revenue, profit, gross margin,
  R&D), against the A-share companies of the 申万一级 industry asked for, or else the one most A-share companies in
  the comparison are in; neither market reports cash paid to staff, so its pay measure is missing and shown as
  bounds, and amounts stay in the report's own currency (only ratios are compared). Unlisted companies are not
  placed: they publish no statements.
  2026-10-20: no caps by default — the person's call. A person's pace and the 24-hour stop at the first check stay;
  caps (and halving them after a start or a stop) are there for whoever sets them in `jobos.yaml` → `boss`.
- **D-30 · 2026-10-21 · 企业情况: each kind on its own period, fetched behind the card.** The card fetched every kind
  at once and called itself stale when any kind passed 30 days. Now each kind has a period by how fast it changes
  (`EVERY_DAYS`: news and announcements a day; a review in progress three days; Q&A, research reports and forecasts a
  week; statements, dividends and holders a month; industry and staff count a quarter; a listing found half a year,
  nothing found a month). Reading returns what is stored at once and fetches only the stale kinds behind it (one
  refresh per company at a time); a card never generated fetches nothing until asked. The listing is the root: when
  it changes, every kind under it is fetched again. A kind that failed waits an hour, then two, four… up to a day
  (in memory). The card's button fetches everything now. An A-share company is not looked for in the listing-review
  lists. Reviewed by Codex (2026-10-21), which also asked for a background sweep of the companies the person follows
  and one daily table per exchange for reviews — next steps.
- **D-31 · 2026-10-21 · BOSS 直聘: no automated access in the public tool.** BOSS 直聘's user agreement (article 13,
  read 2026-10-21 at zhipin.com/web/common/protocol/protocol-2019-09-30.html) counts reading, copying or storing its
  content "by spider, crawler or 拟人程序 … rather than a real user" without permission as unlawful acquisition. D-26 to
  D-28 (an agent opening BOSS pages in the person's browser under permits; Zhiro driving a dedicated Chrome and
  listening to the page's own data) are such programs, so they are out of the public tool: the services, the boss.*
  tools, the settings card, the 找实习 candidate list and the config section. What stays: migrations v37 / v38 and their
  tables (a published migration is not undone; the tables are empty in a new library), the capture bookmark's
  recognising zhipin.com (the person reading a page and saving it), the refusal of a BOSS link captured by an agent,
  and the employer comparison reading boss_candidate rows a library already has. The person who asked for D-28 keeps
  it on a local branch that is never pushed (`local/*`, refused by the pre-push hook), at their own risk.
  Reviewed by Codex (2026-10-21), which advised a local branch over a plugin loader: the BOSS code leans on internals
  a loader would have to expose.
