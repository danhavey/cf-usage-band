# CF Ninjas usage band for Claude Code

A band above the Claude Code prompt box:

```
● cache warm 42m | Pro · 5h 61% · week 32% | monthly usage/limit $12.40 / $50.00 | usage credits $8.15
```

- **Prompt cache**: warm with minutes left, or cold, and a warning five minutes
  before it goes cold.
- **Plan limits**: 5-hour and weekly usage ("no 5h limit" on Ultra).
- **With the CF Ninjas AI Usage Widget on the same computer**: the plan name,
  monthly usage against its limit, and the usage-credit balance.

It works in cloud sessions and local ones. Where the widget isn't on the
computer (a cloud session, say), the band asks Anthropic itself for the plan,
monthly usage and credit balance, the same figures Claude Code's /usage shows.
Type `/usage-band` to see where each figure came from.

## Install

The easiest way: in the CF Ninjas AI Usage Widget's menu, tick
**Show usage band in Claude Code**. It adds the band to your claude.ai account,
and it appears in every new Claude Code session on that account.

By hand: at claude.ai/customize/plugins choose **Add → Add marketplace**, enter
`danhavey/cf-usage-band`, install **cf-usage-band**, then start a new session.

Its only network requests go to Anthropic (api.anthropic.com), signed in as
the session already is: Claude Code adds the sign-in itself, and the band never
sees it. With the widget on the same computer and up to date, it reads the
widget's saved figures instead.

This repository is published from the widget's source; changes made here are
overwritten.
