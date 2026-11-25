export type CacheInfo = {
  /** $.clock.now() of the main loop's last finished turn: the last cache refresh. */
  at: number
  /** How long the cache lives after that: 1 hour on a subscription, 5 minutes on the API. */
  ttlMs: number
}

/** What the CF Ninjas widget last saved on this computer, or NO_WIDGET where it isn't installed (a cloud session). */
export type WidgetCredits = {
  /** The widget's store.json was found on this computer. */
  hasWidget: boolean
  /** Show the band: false only when the widget's "Show usage band in Claude Code" is unticked. */
  isBandOn: boolean
  /** The plan's name as the widget worked it out: Free, Pro, Max, Ultra, Team, Enterprise; null if unknown. */
  plan: string | null
  /** The plan has no 5-hour limit (Ultra). */
  noFiveHour: boolean
  usedDollars: number | null
  limitDollars: number | null
  balanceDollars: number | null
  /** When the widget read them from claude.ai, epoch ms. */
  fetchedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'cf-usage-band': { cache: CacheInfo | null; warnedAt: number; tick: number; credits: WidgetCredits | null }
  }
}
