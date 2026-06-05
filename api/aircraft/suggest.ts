import * as fs from 'fs';
import * as path from 'path';

let aircraftIndex: string[] = [];
try {
  const file = path.join(process.cwd(), 'aircraft-index.json');
  aircraftIndex = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch { aircraftIndex = []; }

const stripped = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export default function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const qExact = q.toLowerCase();
  const qStripped = stripped(q);
  const results = aircraftIndex
    .filter(t => t.toLowerCase().includes(qExact) || stripped(t).includes(qStripped))
    .slice(0, 12);
  res.json(results);
}
