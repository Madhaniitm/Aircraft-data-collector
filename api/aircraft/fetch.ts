import {
  findAircraftPage, fetchWikitext,
  mapAircraftSpecs, extractAllInfoboxes,
} from '../_lib';

export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { names } = req.body as { names: string[] };
  if (!Array.isArray(names) || !names.length)
    return res.status(400).json({ error: 'names must be a non-empty array.' });

  const fetchOne = async (rawName: string) => {
    const name = String(rawName).trim();
    try {
      // 2 API calls per aircraft: find page + fetch wikitext
      const pageTitle = await findAircraftPage(name);
      const wikitext = await fetchWikitext(pageTitle);
      let merged: Record<string, string> = {};
      if (wikitext) {
        merged = { ...extractAllInfoboxes(wikitext), ...mapAircraftSpecs(wikitext) };
      }
      const params = Object.fromEntries(Object.entries(merged).filter(([, v]) => v && v.trim()));
      return {
        name,
        params,
        source: `https://en.wikipedia.org/wiki/${encodeURIComponent(pageTitle.replace(/ /g, '_'))}`,
      };
    } catch (err: any) {
      return { name, params: {}, error: err?.message || 'Failed to fetch data.' };
    }
  };

  // Sequential to avoid overwhelming Wikipedia API (2 calls × N aircraft)
  const items: any[] = [];
  for (const name of names) {
    items.push(await fetchOne(name));
  }
  res.json(items);
}
