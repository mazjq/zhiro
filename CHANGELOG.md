# Changelog

## [0.3.0](https://github.com/mazjq/zhiro/compare/v0.2.1...v0.3.0) (2026-10-31)


### Features

* **agent:** find the new address of a subscription whose site moved ([#72](https://github.com/mazjq/zhiro/issues/72)) ([3688fc6](https://github.com/mazjq/zhiro/commit/3688fc681a776b46828b997f9c1e9a36f8f4d28b))
* **brief:** an application an agent recorded as sent, with no proof since, is asked about (R19) ([#40](https://github.com/mazjq/zhiro/issues/40)) ([f63aba9](https://github.com/mazjq/zhiro/commit/f63aba975328ecb4a07df536518eb93428619b88))
* **brief:** each morning a brief of what changed ([#31](https://github.com/mazjq/zhiro/issues/31)) ([7859630](https://github.com/mazjq/zhiro/commit/78596300d4ab0619d261510248d624a48a1fe50d))
* **budget:** background work waits for the allowance, a test, or a full screen ([#25](https://github.com/mazjq/zhiro/issues/25)) ([f4f4f4e](https://github.com/mazjq/zhiro/commit/f4f4f4e25aa392d90e5409d7d99b9397f79bdda3))
* **cards:** confirm cards say what they are now; done / void ones fold away, run-out ones are raised again ([#30](https://github.com/mazjq/zhiro/issues/30)) ([9ccf948](https://github.com/mazjq/zhiro/commit/9ccf9485c7a357252769a62663f551aba27b4146))
* **companies:** track a company by name before it posts anything ([#75](https://github.com/mazjq/zhiro/issues/75)) ([873b040](https://github.com/mazjq/zhiro/commit/873b040162974bb2b7fa582990908435ad060d07))
* **data:** subscribe to a signed data source, filed as a local read would be ([#36](https://github.com/mazjq/zhiro/issues/36)) ([21c6516](https://github.com/mazjq/zhiro/commit/21c6516eba42243ecd94d703f75457df3afb729a))
* **feed:** rows the sender held back come as post ids: still there, never closed ([#38](https://github.com/mazjq/zhiro/issues/38)) ([faf66f4](https://github.com/mazjq/zhiro/commit/faf66f40e9268d2dc30836a1cc7f0aee2a2292c3))
* **gaps:** a skill still being learned counts as knowing of it, not having used it ([#76](https://github.com/mazjq/zhiro/issues/76)) ([68bb870](https://github.com/mazjq/zhiro/commit/68bb87083df06fad830f86616659dd274c447ec1))
* **inbox:** clear recruiting mail is filed on its own, told, and can be undone ([#29](https://github.com/mazjq/zhiro/issues/29)) ([df21760](https://github.com/mazjq/zhiro/commit/df21760e6c40192ae839e22913a7851cbafa8804))
* **inbox:** mail kept before classifying, better linking, tests reminded of from the mail, replay ([#28](https://github.com/mazjq/zhiro/issues/28)) ([4859037](https://github.com/mazjq/zhiro/commit/4859037e4cc6797a2a1a53c513cf83b32f6b38bc))
* **maintenance:** read-only start, and a compare run of two builds on copies of one snapshot ([#22](https://github.com/mazjq/zhiro/issues/22)) ([e87e5f2](https://github.com/mazjq/zhiro/commit/e87e5f26f1538f4a8c5f362bd93f3d041030325d))
* **notice:** a company's full name from the same outside record as its site passes the issuer check ([#59](https://github.com/mazjq/zhiro/issues/59)) ([548e361](https://github.com/mazjq/zhiro/commit/548e361ce349644a48aeca483d1ce936dd4d7c5d))
* **notice:** a company's own sites are those on record with their evidence; revoking one undoes what leaned on it ([#56](https://github.com/mazjq/zhiro/issues/56)) ([87503d5](https://github.com/mazjq/zhiro/commit/87503d5edec4240451e5e5765aa23bd8c6714b75))
* **notice:** a hiring site one link away from a company's known site is on record as its own ([#58](https://github.com/mazjq/zhiro/issues/58)) ([b9b2460](https://github.com/mazjq/zhiro/commit/b9b2460e75ce08dd5bf09fd665ca066c6ea232a0))
* **notice:** a listed company's website disclosed on 巨潮 is on record as its own ([#57](https://github.com/mazjq/zhiro/issues/57)) ([c51821b](https://github.com/mazjq/zhiro/commit/c51821bd37a39e7f167067dd48bd3eb68d098458))
* **notice:** a WeChat account verified as an organisation's, named for the company, is its publisher ([#63](https://github.com/mazjq/zhiro/issues/63)) ([88e61e1](https://github.com/mazjq/zhiro/commit/88e61e1ca6a89e27d5a98d5bd0c39c7cd2d0c5ae))
* **notice:** check what an announcement says of a deadline; only what passes all four checks decides ([#47](https://github.com/mazjq/zhiro/issues/47)) ([7094062](https://github.com/mazjq/zhiro/commit/7094062ae081ddb45ea8c3679e299616bc8afc4d))
* **notice:** notice.verify reads a batch's announcement, asks once, checks and files it ([#48](https://github.com/mazjq/zhiro/issues/48)) ([61c85a9](https://github.com/mazjq/zhiro/commit/61c85a91bc338edfa267f4221fe9e8ba5c19d963))
* **notice:** posters read twice by two models; checks that no longer let a loose answer through ([#50](https://github.com/mazjq/zhiro/issues/50)) ([f5c9465](https://github.com/mazjq/zhiro/commit/f5c9465ae57206ef253acdf4e4007deb3e303bdd))
* **notice:** preparing an application checks its announcement; the post's page says what was found ([#54](https://github.com/mazjq/zhiro/issues/54)) ([5f1b8bf](https://github.com/mazjq/zhiro/commit/5f1b8bf85ab10c68ad1c16f04843a6455818d909))
* **notice:** the announcement must be the batch's kind of recruitment; one not found among the batch's links is looked for on the company's own sites ([#61](https://github.com/mazjq/zhiro/issues/61)) ([7350fa6](https://github.com/mazjq/zhiro/commit/7350fa64600e8ff0a72781e48fa457d4f60847d3))
* **notify:** notices reach the person or say they did not; unread ones are pressed ([#26](https://github.com/mazjq/zhiro/issues/26)) ([e64591d](https://github.com/mazjq/zhiro/commit/e64591db42c7df08bc772c74cefd3b73a18c264e))
* **pool:** stale information leaves the everyday lists ([#35](https://github.com/mazjq/zhiro/issues/35)) ([236a696](https://github.com/mazjq/zhiro/commit/236a69652a511e39661305617d19436b5bf0b444))
* **readers:** 图谱 tupu360 career sites ([#70](https://github.com/mazjq/zhiro/issues/70)) ([ded763d](https://github.com/mazjq/zhiro/commit/ded763d980c53b448618385c411745571657744c))
* **scan:** back off by why a read failed, space out reads of one platform, keep what a read cost ([#67](https://github.com/mazjq/zhiro/issues/67)) ([b9c4307](https://github.com/mazjq/zhiro/commit/b9c43071a4236682bbf0094c9483cf0fc952799a))
* **sources:** name what is wrong with a source, and fix what a program can ([#68](https://github.com/mazjq/zhiro/issues/68)) ([ef20d43](https://github.com/mazjq/zhiro/commit/ef20d43576d5bf17c0db658cf49675d3367257c0))
* **sync:** read failing subscriptions again when the reading code changes ([#73](https://github.com/mazjq/zhiro/issues/73)) ([da92ca9](https://github.com/mazjq/zhiro/commit/da92ca9fe1a38979f269680293ae4f10e6123634))


### Bug Fixes

* **config:** a wrong setting falls back to its default and the start says so (A13) ([#42](https://github.com/mazjq/zhiro/issues/42)) ([85e0f32](https://github.com/mazjq/zhiro/commit/85e0f3210bac7ed73e6b79dadb0fede58030e16e))
* **contracts:** say which tools reach the internet; data.export writes (B27) ([#41](https://github.com/mazjq/zhiro/issues/41)) ([b29a447](https://github.com/mazjq/zhiro/commit/b29a4473eb4d1bbdb368f3de428099720cf37e2e))
* **data:** a full read closes only posts no subscription lists any more (B34) ([#33](https://github.com/mazjq/zhiro/issues/33)) ([6283cbd](https://github.com/mazjq/zhiro/commit/6283cbd3ea79819278d67f1187d8b124674eb45a))
* **deadlines:** a statement that comes back replaces the one between; another reach on the same page stays ([#46](https://github.com/mazjq/zhiro/issues/46)) ([b2d5ad9](https://github.com/mazjq/zhiro/commit/b2d5ad9a1ff145c2613a54cf0fedf0a93e685e79))
* **deadlines:** count days to a deadline in Beijing calendar days ([#74](https://github.com/mazjq/zhiro/issues/74)) ([f3f639a](https://github.com/mazjq/zhiro/commit/f3f639a0c9870f0c4dadbcccceca61d14d0ba7b5))
* **extract:** a long poster goes to the model in slices within one pixel budget ([#65](https://github.com/mazjq/zhiro/issues/65)) ([fb4fccc](https://github.com/mazjq/zhiro/commit/fb4fcccd571c15ccb5b47a2916d29ecfc97d8148))
* **inbox:** the mail poll starts again after the last mailbox was disconnected and one is connected ([#23](https://github.com/mazjq/zhiro/issues/23)) ([28ab108](https://github.com/mazjq/zhiro/commit/28ab1085bd99e7d04ae1f8af09f19071defb751a))
* **net:** an address from outside never reaches this machine or the local network ([#45](https://github.com/mazjq/zhiro/issues/45)) ([3275f53](https://github.com/mazjq/zhiro/commit/3275f538869d50c79dea1255d5e4a9f4c356ec14))
* **notice:** a poster's dates — 「2026 8.10 ▶ 12.31」 is a range ending 2026-12-31 ([#52](https://github.com/mazjq/zhiro/issues/52)) ([69c4838](https://github.com/mazjq/zhiro/commit/69c4838a85a0fb75788bfe99e123d30d9eb07dbe))
* **notice:** an empty model reply is asked again, then leaves that one piece unread ([#64](https://github.com/mazjq/zhiro/issues/64)) ([91c2cc0](https://github.com/mazjq/zhiro/commit/91c2cc0536455d78fb0a883e710daad6d0594350))
* **notice:** an unproven WeChat account is said to be unproven, not left for the person to confirm ([#60](https://github.com/mazjq/zhiro/issues/60)) ([b187344](https://github.com/mazjq/zhiro/commit/b1873444fb8de17ed703f3ec4c0fb8b84de4f7cc))
* **notice:** the post's page goes by the latest check of each page, not the first ([#55](https://github.com/mazjq/zhiro/issues/55)) ([ef27a36](https://github.com/mazjq/zhiro/commit/ef27a3668b909588f762f4a5ca3ea3e7d72c2a0e))
* **notice:** what a first run on real announcements showed ([#49](https://github.com/mazjq/zhiro/issues/49)) ([efa9bad](https://github.com/mazjq/zhiro/commit/efa9bad01de0bb15da0e485fb6b3b87d4c25c055))
* **notice:** what a review of the identity plan found in the checks as they are ([#53](https://github.com/mazjq/zhiro/issues/53)) ([f446176](https://github.com/mazjq/zhiro/commit/f446176332fe11e11ea50eddf1d4cd63a2acb87f))
* **notice:** what the second real run showed ([#51](https://github.com/mazjq/zhiro/issues/51)) ([2861b25](https://github.com/mazjq/zhiro/commit/2861b2544601f9ffe191951dfdc262d0c2308569))
* **policy:** MCP tool notes say what the tier rule does; evals never default to a real data folder ([#21](https://github.com/mazjq/zhiro/issues/21)) ([63ff7f4](https://github.com/mazjq/zhiro/commit/63ff7f4a4a15d49c8df67da026aafd5a131dd04b))
* **readers:** a list read only in part closes nothing, and the page caps stop being the size of a list ([#69](https://github.com/mazjq/zhiro/issues/69)) ([e799263](https://github.com/mazjq/zhiro/commit/e7992637074bdcda1877e1fed0e037c675ae4fde))
* **readers:** the developer queue — 51job's other API and built sites, Moka on DingTalk, a group site that is gone ([#71](https://github.com/mazjq/zhiro/issues/71)) ([91d7868](https://github.com/mazjq/zhiro/commit/91d78687d55da21e6a4d2e0dab1807981cc7d82d))
* **reminders:** a deadline that moves back is said too (B28) ([#39](https://github.com/mazjq/zhiro/issues/39)) ([1f9d18d](https://github.com/mazjq/zhiro/commit/1f9d18d7aabfb66e1afa29f4acb30a8e4fbac86e))
* **sheet:** split a cell on spaces only where every word is Chinese ([#37](https://github.com/mazjq/zhiro/issues/37)) ([afd8665](https://github.com/mazjq/zhiro/commit/afd8665538d597eb0dfa4a2f9711924c5ba541e7))
* **status:** count only work running now; say the quota look reads nothing new ([#32](https://github.com/mazjq/zhiro/issues/32)) ([3905f23](https://github.com/mazjq/zhiro/commit/3905f238cc53530461f2914d9de34b73d6ecc2c7))
* **time:** follow the computer's zone when Node and the browser cannot name it ([#34](https://github.com/mazjq/zhiro/issues/34)) ([b47810f](https://github.com/mazjq/zhiro/commit/b47810f73548e76cf958063412266fbd27a7bd56))
* **today:** a company or post on 今日 opens on 找岗位 itself, not an empty search ([#44](https://github.com/mazjq/zhiro/issues/44)) ([9ba22d2](https://github.com/mazjq/zhiro/commit/9ba22d2b60effa9cce1e51a5016469902d083dfb))

## [0.2.1](https://github.com/mazjq/zhiro/compare/v0.2.0...v0.2.1) (2026-10-21)


### Bug Fixes

* **copy:** 「资料」 on screen instead of 「画像」; 待补资料 → 岗位信息不全 ([#19](https://github.com/mazjq/zhiro/issues/19)) ([efaf90a](https://github.com/mazjq/zhiro/commit/efaf90a677b46c5066e2ad6879eacfba6ae7313d))

## [0.2.0](https://github.com/mazjq/zhiro/compare/v0.1.2...v0.2.0) (2026-10-21)


### Features

* **intel:** each kind of 企业情况 on its own period, fetched behind the card (D-30) ([#17](https://github.com/mazjq/zhiro/issues/17)) ([37b473f](https://github.com/mazjq/zhiro/commit/37b473fcb3adecab8c7d89295d7bd5b22f6667ee))
* pick the harness model from the installed harness's own list ([#4](https://github.com/mazjq/zhiro/issues/4)) ([8f696b2](https://github.com/mazjq/zhiro/commit/8f696b23f529b6adeb822e8d02c8af7b157a2497))
* subscribe to a 高校人才网 column — research institutes, labs, university teams and small firms that never post on a hiring system ([#6](https://github.com/mazjq/zhiro/issues/6)) ([9e2d1c3](https://github.com/mazjq/zhiro/commit/9e2d1c3cdedbfdbdfa1d80437fa92b9150653c36))
* 就业评估报告 — Zhiro writes the facts (statements, places among peers, headcount and pay per head), the person's agent writes why profit moved, where the money went, incentives, listing and fit, each conclusion with its evidence and limits (D-29) ([e03d2af](https://github.com/mazjq/zhiro/commit/e03d2afffd57f4604decad767017f605711e5168))
* 找实习 — every open internship in one list, its own page in the sidebar ([#7](https://github.com/mazjq/zhiro/issues/7)) ([078fd4f](https://github.com/mazjq/zhiro/commit/078fd4f459edf58d2b0758eacb82b3655e6244ca))
* 找实习 leads with the internships most related to the profile, each with its fit ([#9](https://github.com/mazjq/zhiro/issues/9)) ([2769fc2](https://github.com/mazjq/zhiro/commit/2769fc23d2e23ab89760b818f056d6ad5a461ac2))
* 比较单位 — where each employer stands among the listed companies of its industry, and its place under the preferences the person picks, with how far it moves; no total score (D-29) ([e03d2af](https://github.com/mazjq/zhiro/commit/e03d2afffd57f4604decad767017f605711e5168))
* 调研 → 比较 → 就业评估 in one line; reports open in a reading pane ([#13](https://github.com/mazjq/zhiro/issues/13)) ([307ba6e](https://github.com/mazjq/zhiro/commit/307ba6e92ba3c8483b7d1aea1b97da7f75b7dc24))


### Bug Fixes

* **company card:** 写一份 always shown; no IPO lookup for A-share; plain note when a kind is not fetched ([#15](https://github.com/mazjq/zhiro/issues/15)) ([12e58de](https://github.com/mazjq/zhiro/commit/12e58dea576e1abc16ade2bdcc498893186b12eb))
* **employer:** an unlisted company's BOSS entry under its own name only; its listing review keeps its date ([#16](https://github.com/mazjq/zhiro/issues/16)) ([388d473](https://github.com/mazjq/zhiro/commit/388d4737fac06dad330b4fe908a5bbf7fb45e3f2))
* **employer:** one refresh period — everything for comparing employers is used for a week (D-29) ([#14](https://github.com/mazjq/zhiro/issues/14)) ([5a08ba0](https://github.com/mazjq/zhiro/commit/5a08ba0309ff550ee2e9cbdf3972fca1ed86272d))

## [0.1.2](https://github.com/mazjq/zhiro/compare/v0.1.1...v0.1.2) (2026-10-15)


### Bug Fixes

* pool.list's short form lists every matched post, so nothing an agent should find is out of reach ([abc4bf3](https://github.com/mazjq/zhiro/commit/abc4bf3ed96682589e6255fd28b371f40d47a5ca))
* pool.list's short form lists the posts whose title has the search words, not only the profile's matches ([eed433b](https://github.com/mazjq/zhiro/commit/eed433be5c872b4aa9322e2e2cc9090c448030fa))


### Performance Improvements

* fewer tokens for agents — short form of the list tools, one copy of each result for Codex ([f4550d3](https://github.com/mazjq/zhiro/commit/f4550d3a25d104ddc4c67c71f0db5f48cc7e96de))

## [0.1.1](https://github.com/mazjq/zhiro/compare/v0.1.0...v0.1.1) (2026-10-15)


### Bug Fixes

* the npm package is @mazjq/zhiro (npm refused the bare name as too close to "tjiro"); the command is still zhiro ([0952bd7](https://github.com/mazjq/zhiro/commit/0952bd7f841b587eb8e55692cb630af2d865d496))

## 0.1.0 (2026-10-15)


### Features

* Zhiro · 职路 — local-first AI career research and job hunting ([e3656b5](https://github.com/mazjq/zhiro/commit/e3656b512140b14a36a4f079a1c8a39eb830cae7))


### Bug Fixes

* **applications:** events in the same millisecond keep the order they were written in (the last event was a coin toss) ([2b595ae](https://github.com/mazjq/zhiro/commit/2b595ae2727734a9cfc084b48c6df325329f237d))
* macOS / Linux and Node 22.13 / 24 differences found by the first CI run ([b0ac337](https://github.com/mazjq/zhiro/commit/b0ac337ad29cd51c5e87679aff49dc9b5b517586))
