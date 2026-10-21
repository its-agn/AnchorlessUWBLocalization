import { create } from 'zustand'
import { listCases, loadCase, loadFiles } from '@/data/loadCase'
import { LiveSession } from '@/data/liveSession'
import { ReplaySession, type Session } from '@/engine/session'

export type Theme = 'light' | 'dark' | 'system'

interface AppState {
  cases: string[]
  session: Session | null
  /** Bumped whenever session data changes; components re-render off it. */
  frame: number
  loading: boolean
  error: string | null
  playing: boolean
  speed: number
  selectedLink: string | null
  showTruth: boolean
  frameMode: 'truth' | 'relative'
  nlosWeighting: boolean
  theme: Theme

  init(): Promise<void>
  openCase(name: string): Promise<void>
  openFiles(files: File[]): Promise<void>
  connectLive(url: string): void
  tick(): void
  setPlaying(p: boolean): void
  seek(tUs: number): void
  set<K extends keyof AppState>(k: K, v: AppState[K]): void
  setNlosWeighting(on: boolean): void
}

const readPref = <T,>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(k)
    return v == null ? d : (JSON.parse(v) as T)
  } catch {
    return d
  }
}
const writePref = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v))
  } catch {
    /* storage unavailable: preference just isn't remembered */
  }
}

export const useApp = create<AppState>((set, get) => {
  const bump = () => set((s) => ({ frame: s.frame + 1 }))
  const replace = (session: Session) => {
    get().session?.dispose()
    set({
      session,
      error: null,
      loading: false,
      playing: session.kind === 'replay',
      selectedLink: session.pipeline.links.keys().next().value ?? null,
      frameMode: session.scorer ? 'truth' : 'relative',
      showTruth: !!session.scorer && get().showTruth,
    })
    bump()
  }
  const fail = (e: unknown) => set({ loading: false, error: e instanceof Error ? e.message : String(e) })

  return {
    cases: [],
    session: null,
    frame: 0,
    loading: false,
    error: null,
    playing: false,
    speed: readPref('speed', 1),
    selectedLink: null,
    showTruth: readPref('showTruth', true),
    frameMode: 'truth',
    nlosWeighting: true,
    theme: readPref<Theme>('theme', 'system'),

    async init() {
      const cases = await listCases()
      set({ cases })
      // Deep links: ?case=TC08_nlos_obstruction&t=12.5&paused  or  ?live=ws://host:port/path
      const q = new URLSearchParams(location.search)
      const live = q.get('live')
      if (live) return get().connectLive(live)
      const wanted = q.get('case')
      const last = readPref<string | null>('case', null)
      const first = [wanted, last].find((c) => c && cases.includes(c)) ?? cases[0]
      if (!first) return
      await get().openCase(first)
      const t = Number(q.get('t'))
      if (t > 0) get().seek(t * 1e6)
      if (q.has('paused')) set({ playing: false })
    },

    async openCase(name) {
      set({ loading: true, error: null })
      try {
        const rec = await loadCase(name)
        writePref('case', name)
        replace(new ReplaySession(rec, { nlosWeighting: get().nlosWeighting }))
      } catch (e) {
        fail(e)
      }
    },

    async openFiles(files) {
      set({ loading: true, error: null })
      try {
        const rec = await loadFiles(files)
        replace(new ReplaySession(rec, { nlosWeighting: get().nlosWeighting }))
      } catch (e) {
        fail(e)
      }
    },

    connectLive(url) {
      try {
        replace(new LiveSession(url, get().nlosWeighting, bump))
      } catch (e) {
        fail(e)
      }
    },

    tick() {
      bump()
    },

    setPlaying(p) {
      const s = get().session
      if (p && s instanceof ReplaySession && s.finished) s.seek(0)
      set({ playing: p })
      bump()
    },

    seek(tUs) {
      const s = get().session
      if (s instanceof ReplaySession) {
        s.seek(tUs)
        bump()
      }
    },

    set(k, v) {
      set({ [k]: v } as Partial<AppState>)
      if (k === 'speed' || k === 'showTruth' || k === 'theme') writePref(k, v)
    },

    setNlosWeighting(on) {
      set({ nlosWeighting: on })
      const s = get().session
      if (s instanceof ReplaySession) s.setOptions({ nlosWeighting: on })
      bump()
    },
  }
})
