/**
 * Run this ONCE to build the aircraft name index from Wikipedia.
 * Usage: npx ts-node src/build-index.ts
 *
 * Saves aircraft-index.json to the project root.
 * After this, the server loads suggestions from that file instantly.
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const UA = { headers: { 'User-Agent': 'AircraftDataCollector/1.0' } };
const OUTPUT = path.join(__dirname, '../../aircraft-index.json');

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

const wikiSearch = async (template: string, offset: number): Promise<string[]> => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await axios.get(
        `https://en.wikipedia.org/w/api.php?action=query&list=search` +
        `&srsearch=hastemplate:${template}&srlimit=500&sroffset=${offset}` +
        `&format=json&srnamespace=0&srprop=`,
        UA
      );
      return (res.data.query?.search || []).map((h: any) => h.title as string);
    } catch (e: any) {
      if (e?.response?.status === 429) {
        const wait = parseInt(e.response.headers?.['retry-after'] || '10', 10) * 1000;
        console.log(`  429 — waiting ${wait / 1000}s...`);
        await delay(wait);
      } else throw e;
    }
  }
  return [];
};

async function build() {
  const titles = new Set<string>();

  const templates = [
    { name: 'Infobox aircraft', q: '"Infobox aircraft"' },
    { name: 'Aircraft specs',   q: '"Aircraft specs"' },
    { name: 'Infobox weapon',   q: '"Infobox weapon"' },
  ];

  for (const { name, q } of templates) {
    console.log(`\nFetching: ${name}...`);
    let offset = 0;
    let page = 0;

    while (page < 20) {
      const hits = await wikiSearch(q, offset);
      if (!hits.length) break;

      hits.forEach(t => titles.add(t));
      console.log(`  page ${page + 1}: +${hits.length} titles (total: ${titles.size})`);

      offset += hits.length;
      page++;
      if (hits.length < 500) break; // last page

      await delay(1000); // 1s between pages — stays within Wikipedia rate limit
    }
  }

  const sorted = Array.from(titles).sort();
  fs.writeFileSync(OUTPUT, JSON.stringify(sorted, null, 0));
  console.log(`\nDone! Saved ${sorted.length} aircraft titles to aircraft-index.json`);
}

build().catch(e => { console.error('Error:', e.message); process.exit(1); });
