// Serves the generated test cases from ../Localization/test_cases under /cases/
// on the dev and preview servers, so the app can replay them without copying data.
import fs from 'node:fs'
import path from 'node:path'
import type { Connect, Plugin } from 'vite'

const ALLOWED_FILES = new Set(['measurements.jsonl', 'labels.jsonl', 'ground_truth.csv', 'scenario.json'])

function middleware(root: string): Connect.NextHandleFunction {
  return (req, res, next) => {
    const url = (req.url ?? '').split('?')[0]
    if (!url.startsWith('/cases/')) return next()
    const rest = decodeURIComponent(url.slice('/cases/'.length))

    if (rest === 'index.json') {
      const cases = fs.existsSync(root)
        ? fs.readdirSync(root, { withFileTypes: true })
            .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'measurements.jsonl')))
            .map((d) => d.name)
            .sort()
        : []
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(cases))
      return
    }

    // Only <case>/<known file>; no path traversal.
    const parts = rest.split('/')
    if (parts.length !== 2 || !ALLOWED_FILES.has(parts[1]) || !/^[\w-]+$/.test(parts[0])) {
      res.statusCode = 404
      res.end()
      return
    }
    const file = path.join(root, parts[0], parts[1])
    if (!fs.existsSync(file)) {
      res.statusCode = 404
      res.end()
      return
    }
    res.setHeader('Content-Type', parts[1].endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8')
    fs.createReadStream(file).pipe(res)
  }
}

export function testCasesPlugin(root: string): Plugin {
  return {
    name: 'uwb-test-cases',
    configureServer(server) {
      server.middlewares.use(middleware(root))
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware(root))
    },
  }
}
