import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheInfo, WidgetCredits } from '../types'

// A band above the prompt: is this session's prompt cache warm and how long
// is left, the plan's 5-hour and weekly usage, and - from the CF Ninjas usage
// widget on this computer - monthly usage against its limit and the
// usage-credit balance. The widget also says which plan this is (Free to
// Ultra), and whether it has a 5-hour limit at all (Ultra does not).
//
// Installing the band is the opt-in. Two ways to install it: the widget's tray
// menu ("Show usage band in Claude Code") installs it on that computer, and
// adding this repo's marketplace at claude.ai/customize/plugins syncs it to
// every session signed in to that account, cloud sessions included.
//
// Where the widget is on this computer, its switch rules: unticked
// (store.json `showClaudeCodeBand: false`) hides the band. Where there is no
// widget - a cloud session, or a computer without it - the band shows what the
// session itself knows: the cache timer and the 5-hour and weekly figures.
//
// No cost estimates: everyone using it is on a subscription, where list-price
// dollars for tokens would only confuse.

const cache = atom({ plugin: 'cf-usage-band', key: 'cache' } as const, null)
const warnedAt = atom({ plugin: 'cf-usage-band', key: 'warnedAt' } as const, 0)
// Bumped every 30s so the minutes-left figure redraws.
const tick = atom({ plugin: 'cf-usage-band', key: 'tick' } as const, 0)
const credits = atom({ plugin: 'cf-usage-band', key: 'credits' } as const, null)

const HOUR = 60 * 60 * 1000
const FIVE_MIN = 5 * 60 * 1000
const WARN_BEFORE = 5 * 60 * 1000
// The widget polls every few minutes; older than this and the figures are
// not shown rather than shown stale.
const CREDITS_MAX_AGE = 30 * 60 * 1000

const STORE_DIR = 'CF Ninjas AI Usage Widget'

const money = (n: number) => `$${n.toFixed(2)}`


// The widget's store.json: %APPDATA% on Windows, Application Support on a Mac.
async function storePath($: EngineInterface): Promise<string | null> {
  const appData = await $.env.get('APPDATA')
  if (appData) return `${appData}\\${STORE_DIR}\\store.json`
  const home = await $.env.get('HOME')
  if (!home) return null
  const mac = `${home}/Library/Application Support/${STORE_DIR}/store.json`
  if (await $.fs.exists(mac)) return mac
  return `${home}/.config/${STORE_DIR}/store.json`
}

// No widget here: nothing to add, and no switch to say no.
const NO_WIDGET: WidgetCredits = {
  hasWidget: false,
  isBandOn: true,
  plan: null,
  noFiveHour: false,
  usedDollars: null,
  limitDollars: null,
  balanceDollars: null,
  fetchedAt: 0,
}

// null only when the store is there but can't be read right now (mid-write);
// the caller then keeps what it had.
async function readWidgetCredits($: EngineInterface): Promise<WidgetCredits | null> {
  try {
    const p = await storePath($)
    if (!p || !(await $.fs.exists(p))) return NO_WIDGET
    const store = JSON.parse(String(await $.fs.read(p)))
    const isBandOn = !!store && store.showClaudeCodeBand !== false
    const s = store && store.claudeUsageStats
    const plan = s && typeof s.plan === 'string' && s.plan ? s.plan : null
    const noFiveHour = !!(s && s.ok && s.fiveHour && s.fiveHour.none === true)
    const cr = s && s.ok && s.credits && s.credits.enabled && typeof s.fetchedAt === 'number' ? s.credits : null
    const num = (v: unknown) => (cr && typeof v === 'number' ? v : null)
    return {
      hasWidget: true,
      isBandOn,
      plan,
      noFiveHour,
      usedDollars: num(cr && cr.usedDollars),
      limitDollars: num(cr && cr.limitDollars),
      balanceDollars: num(cr && cr.balanceDollars),
      fetchedAt: cr ? s.fetchedAt : 0,
    }
  } catch {
    return null // mid-write, or an older shape
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await update($, credits, () => null)
    const refreshCredits = async () => {
      const c = await readWidgetCredits($)
      if (c) await update($, credits, () => c)
    }
    await refreshCredits()

    $.clock.every(30_000, async () => {
      await update($, tick, n => n + 1)
      await refreshCredits()
      const c = await read($, cache)
      // Switched off in the widget: no band, and no warnings either.
      if (!c || !(await read($, credits))?.isBandOn) return
      const left = c.at + c.ttlMs - (await $.clock.now())
      // One warning per cache refresh, in the last five minutes.
      if (left > 0 && left <= WARN_BEFORE && (await read($, warnedAt)) !== c.at) {
        await update($, warnedAt, () => c.at)
        $.ui.toast(
          `Prompt cache goes cold in ${Math.ceil(left / 60000)} min. ` +
            'After that, your next message re-reads the whole conversation and uses more of your limit; a short message now keeps it warm.',
        )
      }
    })
    return next(e)
  })

  // The main loop's turn just made requests, so the cache was refreshed now.
  // Subagents have caches of their own and leave this one alone.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) return result
    const u = result.usage
    const prev = await read($, cache)
    // The request says which lifetime it wrote; otherwise keep what we knew,
    // else assume a subscription's hour when rate-limit windows are reported.
    let ttlMs = prev?.ttlMs ?? 0
    if (u?.ephemeral_1h_input_tokens) ttlMs = HOUR
    else if (u?.ephemeral_5m_input_tokens) ttlMs = FIVE_MIN
    if (!ttlMs) ttlMs = (await $.session.usage()).rateLimits.length ? HOUR : FIVE_MIN
    const info: CacheInfo = { at: await $.clock.now(), ttlMs }
    await update($, cache, () => info)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    await read($, tick) // redraw on the 30s tick
    const cr = await read($, credits)
    if (!cr || !cr.isBandOn) return next(e)
    const c = await read($, cache)
    const usage = await $.session.usage()
    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)

    const parts: JSX.Element[] = []
    const sep = (k: string) => <Text key={k} dimColor>{' | '}</Text>

    if (!c) {
      parts.push(<Text key="cache" dimColor>cache: no requests yet</Text>)
    } else {
      const left = c.at + c.ttlMs - now
      const mins = Math.max(0, Math.ceil(left / 60000))
      const color = left <= 0 ? 'error' : left <= WARN_BEFORE ? 'warning' : 'success'
      parts.push(
        <Text key="cache" color={color}>
          {left > 0 ? `● cache warm ${mins}m` : '○ cache cold'}
        </Text>,
      )
    }

    // Plan, then its limits: "Pro · 5h 61% · week 32%", or on Ultra, which has
    // no 5-hour limit, "Ultra · no 5h limit · week 32%".
    const pct = (kind: string) => usage.rateLimits.find(r => r.kind === kind)?.percentUsed
    const fh = pct('five_hour')
    const wk = pct('seven_day')
    const bits = [
      cr.plan,
      fh !== undefined
        ? `5h ${Math.round(fh)}%`
        : cr.noFiveHour || (!cr.hasWidget && wk !== undefined)
          ? 'no 5h limit' // without the widget: a weekly reading and no 5-hour one
          : null,
      wk !== undefined ? `week ${Math.round(wk)}%` : null,
    ].filter(Boolean)
    if (bits.length) parts.push(sep('s2'), <Text key="rl" dimColor>{bits.join(' · ')}</Text>)

    // The widget's fetchedAt is wall-clock epoch ms; $.clock.now() is too.
    if (now - cr.fetchedAt <= CREDITS_MAX_AGE) {
      if (cr.usedDollars !== null && cr.limitDollars !== null) {
        parts.push(sep('s3'), <Text key="mo" dimColor>monthly usage/limit {money(cr.usedDollars)} / {money(cr.limitDollars)}</Text>)
      }
      if (cr.balanceDollars !== null) {
        parts.push(sep('s4'), <Text key="bal" dimColor>usage credits {money(cr.balanceDollars)}</Text>)
      }
    }

    return <Box>{parts}</Box>
  })
}
