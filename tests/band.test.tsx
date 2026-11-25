import { expect, test } from 'claude-code/testing'

// The band without the widget (a cloud session): it asks Anthropic itself,
// with the session's sign-in handle, for the plan, the month's usage and the
// credit balance. Each hook below stands for the engine.

const BAND = {
  plugin: 'cf-usage-band',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 200, scroll: { offset: 0, bodyRows: 3 } },
} as const

const ANSWERS: Record<string, unknown> = {
  '/api/oauth/profile': { organization: { uuid: 'org-1', organization_type: 'claude_pro', rate_limit_tier: 'default_claude_ai' } },
  '/api/oauth/usage': {
    five_hour: { utilization: 6 },
    extra_usage: { is_enabled: true, monthly_limit: 2000, used_credits: 287, currency: 'USD' },
  },
  '/api/oauth/organizations/org-1/prepaid/credits': { amount: 4973, currency: 'USD' },
}

// Cloud: no widget file, a subscription sign-in, Anthropic answering.
function engine(on: any, opts: { auth?: boolean; failing?: string[] } = {}) {
  const seen: { url: string; auth?: string }[] = []
  on('env.get', ($: unknown, e: { name: string }) => ({ value: e.name === 'HOME' ? '/home/x' : undefined }))
  on('fs.exists', () => ({ value: false }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'usage-band' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.authorize', () => ({ value: opts.auth === false ? null : { handle: 'h1', kind: 'bearer' } }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 6, source: 'api' },
        { kind: 'seven_day', percentUsed: 1, source: 'api' },
      ],
    },
  }))
  on('http.fetch', (_: unknown, e: { url: string; init?: { auth?: string } }) => {
    const path = e.url.replace('https://api.anthropic.com', '')
    seen.push({ url: e.url, auth: e.init?.auth })
    if ((opts.failing || []).includes(path)) return { value: { status: 403, ok: false, headers: {}, text: '{}' } }
    const body = ANSWERS[path]
    return body
      ? { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
      : { value: { status: 404, ok: false, headers: {}, text: '' } }
  })
  return seen
}

test('without the widget the band fills in plan, monthly usage and credits itself', async ($, on) => {
  const seen = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // The first fetch runs unawaited at start; the command waits for its own.
  const out = await $.command.run({ command: 'usage-band', args: '' })
  expect(out.text).toContain('plan: Pro')
  expect(out.text).toContain('monthly usage: $2.87 of $20.00')
  expect(out.text).toContain('credit balance: $49.73')
  expect(seen.every(s => s.url.startsWith('https://api.anthropic.com/') && s.auth === 'h1')).toBe(true)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /Pro · 5h 6% · week 1%/ }))?.text).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /monthly usage\/limit \$2\.87 \/ \$20\.00/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /usage credits \$49\.73/ }))).toBeTruthy()
    await ui.unmount()
  }
})

test('a refused credits request leaves the rest of the band', async ($, on) => {
  engine(on, { failing: ['/api/oauth/organizations/org-1/prepaid/credits'] })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const out = await $.command.run({ command: 'usage-band', args: '' })
  expect(out.text).toContain('credit balance: HTTP 403')
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /monthly usage\/limit \$2\.87/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /usage credits/ })).toBeFalsy()
  await ui.unmount()
})

test('with no sign-in to use, the band is what it was: cache and 5h/week', async ($, on) => {
  const seen = engine(on, { auth: false })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const out = await $.command.run({ command: 'usage-band', args: '' })
  expect(out.text).toContain('sign-in: none')
  expect(seen.length).toBe(0)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /5h 6% · week 1%/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /monthly usage/ })).toBeFalsy()
  await ui.unmount()
})
