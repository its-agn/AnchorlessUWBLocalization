import { useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ArenaMap } from '@/components/ArenaMap'
import { ErrorChart, GapChart, RangeChart } from '@/components/Charts'
import { Header } from '@/components/Header'
import { EventLog, LinkTable, NodeTable, ScenarioPanel } from '@/components/Panels'
import { ReplayBar } from '@/components/ReplayBar'
import { SummaryStrip } from '@/components/SummaryStrip'
import { ReplaySession } from '@/engine/session'
import { useApp } from '@/state/store'

/** Drives replay from requestAnimationFrame and repaints at ~30 fps. */
function usePlayback() {
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    let lastPaint = 0
    const loop = (now: number) => {
      const dt = now - last
      last = now
      const { session, playing, speed, tick, set } = useApp.getState()
      if (session instanceof ReplaySession && playing) {
        session.runUntil(session.tUs + Math.min(dt, 250) * 1000 * speed)
        if (session.finished) set('playing', false)
      }
      if (session && now - lastPaint > 33 && (playing || session.kind === 'live')) {
        lastPaint = now
        tick()
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])
}

function useTheme() {
  const theme = useApp((s) => s.theme)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && mq.matches)
      document.documentElement.classList.toggle('dark', dark)
      useApp.getState().tick()
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])
}

export default function App() {
  const session = useApp((s) => s.session)
  const loading = useApp((s) => s.loading)
  const error = useApp((s) => s.error)
  usePlayback()
  useTheme()
  useEffect(() => {
    useApp.getState().init()
  }, [])

  return (
    <TooltipProvider>
      <div className="flex min-h-svh flex-col bg-background">
        <Header />
        <ReplayBar />
        {error && <div className="mx-4 mt-3 rounded-lg border border-destructive/40 px-3 py-2 text-sm text-destructive">{error}</div>}
        {!session && (
          <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
            {loading ? 'Loading…' : 'Choose a test case, open a recording, or connect to a live stream.'}
          </div>
        )}
        {session && (
          <>
            <SummaryStrip />
            <main className="grid flex-1 items-start gap-3 p-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
              <div className="grid gap-3">
                <Card>
                  <CardHeader>
                    <CardTitle>Node map</CardTitle>
                    <CardDescription>
                      Estimates with 2σ ellipses and 5 s trails. Links: green LOS, amber uncertain, red NLOS, dashed down.
                      Hollow rings are ground truth. Hover for details, click a link to chart it.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="mx-auto aspect-square w-full max-w-[calc(100svh-300px)] min-w-[280px]">
                      <ArenaMap />
                    </div>
                  </CardContent>
                </Card>
                <ErrorChart />
              </div>
              <div className="grid gap-3">
                <Card>
                  <CardContent>
                    <Tabs defaultValue="links">
                      <TabsList>
                        <TabsTrigger value="links">Links</TabsTrigger>
                        <TabsTrigger value="nodes">Nodes</TabsTrigger>
                        <TabsTrigger value="events">Events</TabsTrigger>
                        <TabsTrigger value="scenario">Scenario</TabsTrigger>
                      </TabsList>
                      <TabsContent value="links" className="pt-2">
                        <LinkTable />
                      </TabsContent>
                      <TabsContent value="nodes" className="pt-2">
                        <NodeTable />
                      </TabsContent>
                      <TabsContent value="events" className="pt-2">
                        <EventLog />
                      </TabsContent>
                      <TabsContent value="scenario" className="pt-2">
                        <ScenarioPanel />
                      </TabsContent>
                    </Tabs>
                  </CardContent>
                </Card>
                <RangeChart />
                <GapChart />
              </div>
            </main>
          </>
        )}
      </div>
    </TooltipProvider>
  )
}
