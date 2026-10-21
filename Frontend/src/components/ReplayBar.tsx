import { Pause, Play, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { fmtTime } from '@/lib/theme'
import { useApp } from '@/state/store'

const SPEEDS = [0.5, 1, 2, 5, 10]

export function ReplayBar() {
  const session = useApp((s) => s.session)
  useApp((s) => s.frame)
  const playing = useApp((s) => s.playing)
  const speed = useApp((s) => s.speed)
  const showTruth = useApp((s) => s.showTruth)
  const frameMode = useApp((s) => s.frameMode)
  const nlosWeighting = useApp((s) => s.nlosWeighting)
  const { set, setPlaying, seek, setNlosWeighting } = useApp.getState()
  if (!session) return null
  const replay = session.kind === 'replay'
  const hasTruth = !!session.scorer

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2">
      {replay && (
        <>
          <div className="flex items-center gap-1">
            <Button size="icon-sm" aria-label={playing ? 'Pause' : 'Play'} onClick={() => setPlaying(!playing)}>
              {playing ? <Pause /> : <Play />}
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label="Restart" onClick={() => seek(0)}>
              <RotateCcw />
            </Button>
          </div>
          <div className="flex min-w-60 flex-1 items-center gap-3">
            <span className="w-12 text-right text-sm tabular-nums">{fmtTime(session.tUs)}</span>
            <Slider
              aria-label="Replay position"
              min={0}
              max={session.durationUs!}
              step={100_000}
              value={[session.tUs]}
              onValueChange={([v]) => seek(v)}
            />
            <span className="w-12 text-sm tabular-nums text-muted-foreground">{fmtTime(session.durationUs!)}</span>
          </div>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={String(speed)}
            onValueChange={(v) => v && set('speed', Number(v))}
            aria-label="Playback speed"
          >
            {SPEEDS.map((s) => (
              <ToggleGroupItem key={s} value={String(s)} className="px-2 tabular-nums">
                {s}×
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </>
      )}
      {!replay && <span className="flex-1 text-sm tabular-nums">t = {fmtTime(session.tUs)}</span>}

      <label className="flex items-center gap-2 text-sm">
        <Switch checked={nlosWeighting} onCheckedChange={setNlosWeighting} />
        NLOS down-weighting
      </label>
      {hasTruth && (
        <>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={showTruth} onCheckedChange={(v) => set('showTruth', v)} />
            Ground truth
          </label>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={frameMode}
            onValueChange={(v) => v && set('frameMode', v as 'truth' | 'relative')}
            aria-label="Map frame"
          >
            <ToggleGroupItem value="truth">Arena frame</ToggleGroupItem>
            <ToggleGroupItem value="relative">Relative</ToggleGroupItem>
          </ToggleGroup>
        </>
      )}
    </div>
  )
}
