# Changelog

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
