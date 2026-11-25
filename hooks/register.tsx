import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheInfo, DirectFigures, WidgetCredits } from '../types'

// A band above the prompt: is this session's prompt cache warm and how long
// is left, the plan's 5-hour and weekly usage, and - from the CF Ninjas usage
// widget on this computer - monthly usage against its limit and the
// usage-credit balance. The widget also says which plan this is (Free to
// Ultra), and whether it has a 5-hour limit at all (Ultra does not).
//
// Installing the band is the opt-in. The widget's tray menu ("Show usage band
// in Claude Code") adds it to the claude.ai account, which syncs it to every
// session signed in to that account, cloud sessions included.
//
// Where the widget is on this computer, its switch rules: unticked
// (store.json `showClaudeCodeBand: false`) hides the band. Where there is no
// widget - a cloud session, or a computer without it - the band shows what the
// session itself knows: the cache timer and the 5-hour and weekly figures.
//
// Without the widget the band asks Anthropic itself, with the session's own
// sign-in (fetchDirect): the plan, monthly usage against its limit and the
// usage-credit balance, the same requests Claude Code makes for /usage. The
// sign-in never reaches this code: $.session.authorize() gives a handle that
// $.http.fetch spends on Anthropic's own host only. So cloud sessions show the
// full band too. Where the widget is on this computer and fresh, its figures
// win. /usage-band says where each figure came from.
//
// No cost estimates: everyone using it is on a subscription, where list-price
// dollars for tokens would only confuse.

const cache = atom({ plugin: 'cf-usage-band', key: 'cache' } as const, null)
const warnedAt = atom({ plugin: 'cf-usage-band', key: 'warnedAt' } as const, 0)
// Bumped every 30s so the minutes-left figure redraws.
const tick = atom({ plugin: 'cf-usage-band', key: 'tick' } as const, 0)
const credits = atom({ plugin: 'cf-usage-band', key: 'credits' } as const, null)
const direct = atom({ plugin: 'cf-usage-band', key: 'direct' } as const, null)

const HOUR = 60 * 60 * 1000
const FIVE_MIN = 5 * 60 * 1000
const WARN_BEFORE = 5 * 60 * 1000
// The widget polls every few minutes; older than this and the figures are
// not shown rather than shown stale.
const CREDITS_MAX_AGE = 30 * 60 * 1000

const STORE_DIR = 'CF Ninjas AI Usage Widget'

const money = (n: number, currency?: string | null) =>
  currency && currency.toUpperCase() !== 'USD' ? `${n.toFixed(2)} ${currency.toUpperCase()}` : `$${n.toFixed(2)}`

// Anthropic's API host, where Claude Code's own /usage figures come from.
// Not a published API: if a request stops working, its figure just isn't shown.
const API = 'https://api.anthropic.com'
const DIRECT_EVERY = 5 * 60 * 1000
const OAUTH_HEADERS = { 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' }


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

// The plan's name from the profile's organization, as the widget names it.
function planFromProfile(org: unknown): string | null {
  if (!org || typeof org !== 'object') return null
  const o = org as { organization_type?: unknown; rate_limit_tier?: unknown }
  const type = typeof o.organization_type === 'string' ? o.organization_type : ''
  const tier = typeof o.rate_limit_tier === 'string' ? o.rate_limit_tier.toLowerCase() : ''
  if (type === 'claude_enterprise') return 'Enterprise'
  if (type === 'claude_team') return 'Team'
  if (type === 'claude_max') return tier.includes('ultra') || tier.includes('20x') ? 'Ultra' : 'Max'
  if (type === 'claude_pro') return 'Pro'
  if (type === 'claude_free') return 'Free'
  return null
}

type Got = { ok: true; data: any } | { ok: false; why: string }

async function getJson($: EngineInterface, path: string, handle: string): Promise<Got> {
  try {
    const r = await $.http.fetch(API + path, { method: 'GET', headers: OAUTH_HEADERS, auth: handle })
    if (!r.ok) return { ok: false, why: `HTTP ${r.status}` }
    return { ok: true, data: JSON.parse(r.text) }
  } catch (err) {
    return { ok: false, why: String((err as Error)?.message ?? err).slice(0, 120) }
  }
}

const cents = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v / 100 : null)

// Asks Anthropic for the plan, the month's usage against its limit, and the
// credit balance. A request that fails keeps what `prev` had for its figures.
async function fetchDirect($: EngineInterface, prev: DirectFigures | null): Promise<DirectFigures> {
  const out: DirectFigures = prev
    ? { ...prev, report: [] }
    : { plan: null, usedDollars: null, limitDollars: null, balanceDollars: null, currency: null, fetchedAt: 0, report: [] }
  let handle: string | null = null
  try {
    const a = await $.session.authorize()
    handle = a && a.kind === 'bearer' ? a.handle : null
    out.report.push(a ? `sign-in: ${a.kind}` : 'sign-in: none (not a Claude subscription login)')
  } catch (err) {
    out.report.push(`sign-in: refused (${String((err as Error)?.message ?? err).slice(0, 120)})`)
  }
  if (!handle) return out

  let org: string | null = null
  const profile = await getJson($, '/api/oauth/profile', handle)
  if (profile.ok) {
    const o = profile.data && profile.data.organization
    org = o && typeof o.uuid === 'string' ? o.uuid : null
    out.plan = planFromProfile(o) ?? out.plan
    out.report.push(`plan: ${out.plan ?? 'unknown'} (${(o && o.organization_type) || 'no organization type'})`)
  } else out.report.push(`plan: ${profile.why}`)

  const usage = await getJson($, '/api/oauth/usage', handle)
  if (usage.ok) {
    const x = usage.data && usage.data.extra_usage
    if (x && x.is_enabled && cents(x.monthly_limit) !== null) {
      out.usedDollars = cents(x.used_credits) ?? 0
      out.limitDollars = cents(x.monthly_limit)
      out.currency = typeof x.currency === 'string' ? x.currency : null
      out.report.push(`monthly usage: ${money(out.usedDollars, out.currency)} of ${money(out.limitDollars ?? 0, out.currency)}`)
    } else {
      out.usedDollars = out.limitDollars = null
      out.report.push('monthly usage: usage credits are off for this account')
    }
  } else out.report.push(`monthly usage: ${usage.why}`)

  if (org) {
    const pre = await getJson($, `/api/oauth/organizations/${encodeURIComponent(org)}/prepaid/credits`, handle)
    if (pre.ok && cents(pre.data && pre.data.amount) !== null) {
      out.balanceDollars = cents(pre.data.amount)
      if (typeof pre.data.currency === 'string') out.currency = out.currency ?? pre.data.currency
      out.report.push(`credit balance: ${money(out.balanceDollars ?? 0, out.currency)}`)
    } else out.report.push(`credit balance: ${pre.ok ? 'no amount in the answer' : pre.why}`)
  } else out.report.push('credit balance: skipped (no organization from the profile)')

  if (profile.ok || usage.ok) out.fetchedAt = await $.clock.now()
  return out
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await update($, credits, () => null)
    const refreshCredits = async () => {
      const c = await readWidgetCredits($)
      if (c) await update($, credits, () => c)
    }
    await refreshCredits()

    // The direct figures: skipped while the widget here has fresh ones, or
    // its switch is off.
    let lastDirect = 0
    const refreshDirect = async () => {
      const now = await $.clock.now()
      const cr = await read($, credits)
      if (now - lastDirect < DIRECT_EVERY) return
      if (cr && !cr.isBandOn) return
      if (cr && cr.hasWidget && now - cr.fetchedAt <= CREDITS_MAX_AGE && cr.plan) return
      lastDirect = now
      const d = await fetchDirect($, await read($, direct))
      await update($, direct, () => d)
    }
    void refreshDirect()
    await $.command.register({ name: 'usage-band', description: "Show where the usage band's figures come from" })

    $.clock.every(30_000, async () => {
      void refreshDirect()
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

  on('command.run', { command: 'usage-band' }, async $ => {
    const cr = await read($, credits)
    const d = await fetchDirect($, await read($, direct))
    await update($, direct, () => d)
    const widget = !cr || !cr.hasWidget
      ? 'widget: not on this computer'
      : `widget: on this computer, band ${cr.isBandOn ? 'on' : 'off'}, figures from ${cr.fetchedAt ? new Date(cr.fetchedAt).toLocaleString() : 'never'}`
    return { text: ['Usage band', widget, ...d.report].join('\n') }
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
    const d = await read($, direct)
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
    const plan = cr.plan ?? d?.plan ?? null
    const bits = [
      plan,
      fh !== undefined
        ? `5h ${Math.round(fh)}%`
        : cr.noFiveHour || plan === 'Ultra' || (!cr.hasWidget && wk !== undefined)
          ? 'no 5h limit' // without the widget: a weekly reading and no 5-hour one
          : null,
      wk !== undefined ? `week ${Math.round(wk)}%` : null,
    ].filter(Boolean)
    if (bits.length) parts.push(sep('s2'), <Text key="rl" dimColor>{bits.join(' · ')}</Text>)

    // The widget's figures when fresh (its fetchedAt is wall-clock epoch ms, as
    // $.clock.now() is), else the band's own.
    const w = cr.hasWidget && now - cr.fetchedAt <= CREDITS_MAX_AGE ? cr : null
    const own = d && now - d.fetchedAt <= CREDITS_MAX_AGE ? d : null
    const used = w?.usedDollars ?? own?.usedDollars ?? null
    const limit = w?.limitDollars ?? own?.limitDollars ?? null
    const balance = w?.balanceDollars ?? own?.balanceDollars ?? null
    const cur = w && w.usedDollars !== null ? null : own?.currency ?? null
    if (used !== null && limit !== null) {
      parts.push(sep('s3'), <Text key="mo" dimColor>monthly usage/limit {money(used, cur)} / {money(limit, cur)}</Text>)
    }
    if (balance !== null) {
      parts.push(sep('s4'), <Text key="bal" dimColor>usage credits {money(balance, cur)}</Text>)
    }

    return <Box>{parts}</Box>
  })
}
