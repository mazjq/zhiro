# Changelog

## [0.2.0](https://github.com/mazjq/zhiro/compare/v0.1.2...v0.2.0) (2026-10-16)


### Features

* pick the harness model from the installed harness's own list ([#4](https://github.com/mazjq/zhiro/issues/4)) ([8f696b2](https://github.com/mazjq/zhiro/commit/8f696b23f529b6adeb822e8d02c8af7b157a2497))

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
