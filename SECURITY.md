# Security

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub:
[Security → Report a vulnerability](https://github.com/mazjq/zhiro/security/advisories/new).
We aim to acknowledge within 7 days and to ship a fix or a mitigation within 30 days.

请不要公开提 issue，用上面的链接私下报告。

## What Zhiro keeps, and where

Zhiro is local-first. Everything it knows about you stays in your **data folder** on your own machine
(see [docs/data.md](docs/data.md) for where that is and how to move, back up, upgrade and roll back):

- the database (`jobos.db`): jobs, your watches and applications, profile cards, research reports;
- settings (`config/jobos.yaml`), and in `config/` the keys: `.daemon-token` (you), `.agent-token` (your agents),
  `credentials.json` (logins of the optional built-in model);
- a separate Chrome profile for filling in applications (it keeps the logins you make there).

The daemon listens on `127.0.0.1` only. Every request needs a key; what an agent may do is decided by which key it
holds, not by what it says it is. Agents can never log in to models, read credentials, or press **Submit** on an
application. Nothing is sent anywhere except the sites you ask Zhiro to read and the model / agent you chose.

## Supported versions

Only the latest release gets security fixes.
