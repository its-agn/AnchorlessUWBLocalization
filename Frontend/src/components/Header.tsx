import { FolderOpen, Monitor, Moon, Radio, Sun } from 'lucide-react'
import { useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useApp, type Theme } from '@/state/store'

const NEXT_THEME: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' }

export function Header() {
  const cases = useApp((s) => s.cases)
  const session = useApp((s) => s.session)
  useApp((s) => s.frame)
  const openCase = useApp((s) => s.openCase)
  const openFiles = useApp((s) => s.openFiles)
  const connectLive = useApp((s) => s.connectLive)
  const theme = useApp((s) => s.theme)
  const set = useApp((s) => s.set)
  const fileInput = useRef<HTMLInputElement>(null)
  const [liveOpen, setLiveOpen] = useState(false)
  const [url, setUrl] = useState('ws://localhost:8765/stream')
  const current = session?.kind === 'replay' && cases.includes(session.name) ? session.name : undefined
  const ThemeIcon = { system: Monitor, light: Sun, dark: Moon }[theme]

  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5">
      <div className="mr-auto min-w-0">
        <h1 className="font-heading text-base font-semibold leading-tight">Anchorless UWB Localization</h1>
        <p className="truncate text-xs text-muted-foreground">
          {session ? (session.kind === 'live' ? `Live · ${session.name}` : `Replay · ${session.name}`) : 'No source loaded'}
          {session?.kind === 'live' && (
            <Badge variant="outline" className="ml-2">
              {session.connection}
            </Badge>
          )}
        </p>
      </div>

      <Select value={current} onValueChange={(v) => openCase(v)}>
        <SelectTrigger className="w-64" aria-label="Test case">
          <SelectValue placeholder={cases.length ? 'Choose a test case' : 'No test cases found'} />
        </SelectTrigger>
        <SelectContent>
          {cases.map((c) => (
            <SelectItem key={c} value={c}>
              {c.replace(/_/g, ' ')}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <input
        ref={fileInput}
        type="file"
        multiple
        className="hidden"
        accept=".jsonl,.json,.csv"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          if (files.length) openFiles(files)
          e.target.value = ''
        }}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
            <FolderOpen /> Open recording
          </Button>
        </TooltipTrigger>
        <TooltipContent>Pick measurements.jsonl (plus scenario.json, labels.jsonl, ground_truth.csv if you have them)</TooltipContent>
      </Tooltip>

      <Button variant={liveOpen ? 'secondary' : 'outline'} size="sm" onClick={() => setLiveOpen((o) => !o)}>
        <Radio /> Live
      </Button>
      {liveOpen && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            connectLive(url)
          }}
        >
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="h-8 w-60 rounded-md border bg-transparent px-2 text-sm"
            aria-label="WebSocket URL"
          />
          <Button size="sm" type="submit">
            Connect
          </Button>
        </form>
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Theme: ${theme}`} onClick={() => set('theme', NEXT_THEME[theme])}>
            <ThemeIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Theme: {theme}</TooltipContent>
      </Tooltip>
    </header>
  )
}
