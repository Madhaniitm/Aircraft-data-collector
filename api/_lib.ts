import axios from 'axios';
import * as cheerio from 'cheerio';

export const UA_OBJ = { headers: { 'User-Agent': 'AircraftDataCollector/1.0 (research tool)' } };

// ── Wikipedia request with retry on 429 ──────────────────────────────────────
export const wikiGet = async (url: string): Promise<any> => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await axios.get(url, UA_OBJ);
    } catch (e: any) {
      if (e?.response?.status === 429) {
        const retryAfter = parseInt(e.response.headers?.['retry-after'] || '5', 10);
        const wait = Math.max(retryAfter * 1000, Math.pow(2, attempt) * 1000);
        await new Promise(r => setTimeout(r, wait));
      } else throw e;
    }
  }
  throw new Error('Wikipedia API unavailable after retries');
};

// ── Value cleaning ────────────────────────────────────────────────────────────
export const cleanWikiValue = (raw: string): string => {
  let v = raw;
  v = v.replace(/<ref[^>]*\/>/gi, '').replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');
  v = v.replace(/\{\{(?:convert|cvt)\|([^|{}]+)\|([^|{}]+)[^{}]*\}\}/gi, '$1 $2');
  v = v.replace(/\{\{[Ss]tart[\s_][Dd]ate[\w\s]*\|(\d{4})\|(\d{1,2})\|(\d{1,2})[^}]*\}\}/g, '$1-$2-$3');
  v = v.replace(/\{\{[Ss]tart[\s_][Dd]ate[\w\s]*\|(\d{4})[^}]*\}\}/g, '$1');
  v = v.replace(/\{\{(?:ubl|plainlist|flat\s*list|unbulleted\s+list|hlist)[^|{]*\|([\s\S]*?)\}\}/gi,
    (_, body) => body.split('|').map((s: string) =>
      s.replace(/\*+/g, '').replace(/\[\[(?:[^\]|]+\|)?([^\]]+)\]\]/g, '$1').trim()
    ).filter(Boolean).join(', ')
  );
  v = v.replace(/\{\{flag(?:country|icon|deco)?\|([^|{}]+)[^{}]*\}\}/gi, '$1');
  v = v.replace(/\[\[(?:[^\]|]+\|)?([^\]]+)\]\]/g, '$1');
  let prev = '';
  while (prev !== v) { prev = v; v = v.replace(/\{\{[^{}]*\}\}/g, ''); }
  v = v.replace(/'{2,3}/g, '').replace(/<br\s*\/?>/gi, ', ').replace(/<[^>]+>/g, ' ');
  v = v.replace(/\[[\w\s]+\]/g, '').replace(/^\s*\*+\s*/gm, '').replace(/\n+/g, ', ');
  return v.replace(/,\s*,+/g, ',').replace(/\s+/g, ' ').replace(/^[,\s]+|[,\s]+$/g, '').trim();
};

const addCommas = (n: string) => n.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// ── Template extraction ───────────────────────────────────────────────────────
const ALWAYS_SKIP = new Set([
  'image','image_size','image_alt','imagewidth','image_caption',
  'caption','alt','logo','map','map_caption','thumbnail',
  'ref','prime_units?','genhide','perfhide','armhide',
]);

export const toCamelCase = (key: string): string =>
  key.toLowerCase().replace(/[-_\s]+(.)/g, (_, c) => c.toUpperCase());

const extractBodyParts = (body: string): Record<string, string> => {
  const parts: string[] = [];
  let seg = 0, d = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if ((c === '{' && body[i + 1] === '{') || (c === '[' && body[i + 1] === '[')) { d++; i++; }
    else if ((c === '}' && body[i + 1] === '}') || (c === ']' && body[i + 1] === ']')) { d--; i++; }
    else if (c === '|' && d === 0) { parts.push(body.slice(seg, i).trim()); seg = i + 1; }
  }
  parts.push(body.slice(seg).trim());
  const raw: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq === -1) continue;
    const rawKey = parts[i].slice(0, eq).trim().toLowerCase().replace(/\s+/g, '_');
    const rawVal = parts[i].slice(eq + 1).trim();
    if (rawKey && rawVal && !rawVal.startsWith('<!--')) raw[rawKey] = rawVal;
  }
  return raw;
};

// ── Unified infobox key map ───────────────────────────────────────────────────
export const UNIFIED_INFOBOX_KEY_MAP: Record<string, string> = {
  type:'role',role:'role',function:'role',classification:'role',aircraft_type:'role',is_missile:'role',primary_function:'role',
  manufacturer:'manufacturer','manufacturer(s)':'manufacturer',builder:'manufacturer',
  designer:'designer',designed_by:'designer',
  national_origin:'countryOfOrigin',origin:'countryOfOrigin',country:'countryOfOrigin',
  designation:'designation',model:'designation',
  variants:'variants',developed_into:'variants',
  first_flight:'firstFlight',maiden_flight:'firstFlight',
  introduction:'serviceEntry',introduced:'serviceEntry',entered_service:'serviceEntry',in_service:'serviceEntry',
  retired:'retired',status:'status',production_status:'status',
  number_built:'numberBuilt',produced:'numberBuilt',units_built:'numberBuilt',number:'numberBuilt',
  primary_user:'primaryUser',primary_users:'primaryUser',operators:'primaryUser',used_by:'primaryUser',users:'primaryUser',
  wingspan:'wingspan',span:'wingspan',length:'length',height:'height',
  width:'fuselageWidth',fuselage_width:'fuselageWidth',fuselage_diameter:'fuselageWidth',
  wing_area:'wingArea',aspect_ratio:'aspectRatio',rotor_diameter:'rotorDiameter',
  cabin_length:'cabinLength',cabin_width:'cabinWidth',cabin_height:'cabinHeight',
  empty_weight:'emptyWeight',weight_empty:'emptyWeight',operating_empty_weight:'emptyWeight',
  gross_weight:'grossWeight',normal_takeoff_weight:'grossWeight',
  weight:'grossWeight',
  max_takeoff_weight:'maxTakeoffWeight',maximum_takeoff_weight:'maxTakeoffWeight',max_weight:'maxTakeoffWeight',
  fuel_capacity:'fuelCapacity',payload:'maxPayload',payload_capacity:'maxPayload',max_payload:'maxPayload',
  maximum_speed:'maxSpeed',max_speed:'maxSpeed',speed:'maxSpeed',top_speed:'maxSpeed',never_exceed_speed:'maxSpeed',
  cruise_speed:'cruiseSpeed',stall_speed:'stallSpeed',
  range:'range',vehicle_range:'range',maximum_range:'range',
  ferry_range:'ferryRange',combat_range:'combatRange',combat_radius:'combatRange',effective_range:'combatRange',
  service_ceiling:'serviceCeiling',ceiling:'serviceCeiling',altitude:'serviceCeiling',
  rate_of_climb:'rateOfClimb',wing_loading:'wingLoading',
  thrust_to_weight:'thrustToWeight',power_to_weight:'thrustToWeight',
  g_limits:'gLimits',endurance:'endurance',
  powerplant:'engineType',engine:'engineType',engines:'engineType',propulsion:'engineType',
  thrust:'thrust',power:'powerOutput',power_output:'powerOutput',propeller:'propeller',
  crew:'crew',armament:'armament',weapons:'armament',warhead:'armament',
  guns:'guns',missiles:'missiles',rockets:'missiles',bombs:'bombs',
  hardpoints:'hardpoints',hardpoint_capacity:'hardpoints',
  avionics:'avionics',guidance:'avionics',radar:'radar',
  passengers:'passengerCapacity',capacity:'passengerCapacity',seating:'passengerCapacity',
  cargo_capacity:'cargoCapacity',icao_code:'icaoCode',iata_code:'iataCode',
  certification:'certification',fly_by_wire:'flyByWire',
};

export const extractAllInfoboxes = (wikitext: string): Record<string, string> => {
  const result: Record<string, string> = {};
  const re = /\{\{[Ii]nfobox\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(wikitext)) !== null) {
    let depth = 0, end = m.index;
    for (let i = m.index; i < wikitext.length - 1; i++) {
      if (wikitext[i] === '{' && wikitext[i + 1] === '{') { depth++; i++; }
      else if (wikitext[i] === '}' && wikitext[i + 1] === '}') {
        depth--; if (depth === 0) { end = i + 2; break; } i++;
      }
    }
    const raw = extractBodyParts(wikitext.slice(m.index + 2, end - 2));
    for (const [rawKey, rawVal] of Object.entries(raw)) {
      if (ALWAYS_SKIP.has(rawKey)) continue;
      const key = UNIFIED_INFOBOX_KEY_MAP[rawKey] || toCamelCase(rawKey);
      if (result[key]) continue;
      const cleaned = cleanWikiValue(rawVal);
      if (cleaned) result[key] = cleaned;
    }
  }
  return result;
};

// ── Aircraft specs template ───────────────────────────────────────────────────
interface SpecDef { param: string; unit?: string; prefix?: string }
const AIRCRAFT_SPECS_MAP: Record<string, SpecDef> = {
  crew:{param:'crew'},capacity:{param:'passengerCapacity'},
  'length ft':{param:'length',unit:'ft'},'length m':{param:'length',unit:'m'},
  'span ft':{param:'wingspan',unit:'ft'},'span m':{param:'wingspan',unit:'m'},
  'height ft':{param:'height',unit:'ft'},'height m':{param:'height',unit:'m'},
  'wing area sqft':{param:'wingArea',unit:'sq ft'},'wing area sqm':{param:'wingArea',unit:'m²'},
  'aspect ratio':{param:'aspectRatio'},
  'rotor diameter ft':{param:'rotorDiameter',unit:'ft'},'rotor diameter m':{param:'rotorDiameter',unit:'m'},
  'empty weight lb':{param:'emptyWeight',unit:'lb'},'empty weight kg':{param:'emptyWeight',unit:'kg'},
  'gross weight lb':{param:'grossWeight',unit:'lb'},'gross weight kg':{param:'grossWeight',unit:'kg'},
  'max takeoff weight lb':{param:'maxTakeoffWeight',unit:'lb'},'max takeoff weight kg':{param:'maxTakeoffWeight',unit:'kg'},
  'fuel capacity':{param:'fuelCapacity'},'payload lb':{param:'maxPayload',unit:'lb'},'payload kg':{param:'maxPayload',unit:'kg'},
  'eng1 name':{param:'engineType'},'eng1 type':{param:'engineType'},'eng1 number':{param:'numberOfEngines'},
  'eng1 lbf':{param:'thrust',unit:'lbf'},'eng1 kn':{param:'thrust',unit:'kN'},
  'eng1 lbf-ab':{param:'thrustWithAfterburner',unit:'lbf'},'eng1 kn-ab':{param:'thrustWithAfterburner',unit:'kN'},
  'eng1 hp':{param:'powerOutput',unit:'hp'},'eng1 kw':{param:'powerOutput',unit:'kW'},'eng1 shp':{param:'powerOutput',unit:'shp'},
  'max speed mach':{param:'maxSpeed',prefix:'Mach '},'max speed kts':{param:'maxSpeed',unit:'kn'},
  'max speed mph':{param:'maxSpeed',unit:'mph'},'max speed kmh':{param:'maxSpeed',unit:'km/h'},
  'never exceed speed kts':{param:'maxSpeed',unit:'kn'},
  'cruise speed kts':{param:'cruiseSpeed',unit:'kn'},'cruise speed mph':{param:'cruiseSpeed',unit:'mph'},
  'stall speed kts':{param:'stallSpeed',unit:'kn'},'stall speed mph':{param:'stallSpeed',unit:'mph'},
  'range nmi':{param:'range',unit:'nmi'},'range miles':{param:'range',unit:'mi'},'range km':{param:'range',unit:'km'},
  'combat range nmi':{param:'combatRange',unit:'nmi'},'combat range miles':{param:'combatRange',unit:'mi'},'combat range km':{param:'combatRange',unit:'km'},
  'ferry range nmi':{param:'ferryRange',unit:'nmi'},'ferry range miles':{param:'ferryRange',unit:'mi'},'ferry range km':{param:'ferryRange',unit:'km'},
  endurance:{param:'endurance'},
  'ceiling ft':{param:'serviceCeiling',unit:'ft'},'ceiling m':{param:'serviceCeiling',unit:'m'},
  'climb rate ftmin':{param:'rateOfClimb',unit:'ft/min'},'climb rate ms':{param:'rateOfClimb',unit:'m/s'},
  'wing loading lb/sqft':{param:'wingLoading',unit:'lb/sq ft'},'wing loading kg/m2':{param:'wingLoading',unit:'kg/m²'},
  'thrust/weight':{param:'thrustToWeight'},'g limits':{param:'gLimits'},
  armament:{param:'armament'},weapons:{param:'armament'},
  guns:{param:'guns'},hardpoints:{param:'hardpoints'},'hardpoint capacity':{param:'hardpoints'},
  rockets:{param:'missiles'},missiles:{param:'missiles'},'hardpoint missiles':{param:'missiles'},
  bombs:{param:'bombs'},'hardpoint bombs':{param:'bombs'},'hardpoint other':{param:'armament'},
  avionics:{param:'avionics'},radar:{param:'radar'},
  'rot dia m':{param:'rotorDiameter',unit:'m'},'rot dia ft':{param:'rotorDiameter',unit:'ft'},
  'disk loading lb/sqft':{param:'wingLoading',unit:'lb/sq ft'},'disk loading kg/m2':{param:'wingLoading',unit:'kg/m²'},
  'power/mass':{param:'thrustToWeight'},'max speed note':{param:'maxSpeed'},'cruise speed note':{param:'cruiseSpeed'},
};

const FT_IN_PAIRS: Record<string, { param: string; inKey: string }> = {
  'length ft':{param:'length',inKey:'length in'},
  'span ft':{param:'wingspan',inKey:'span in'},
  'height ft':{param:'height',inKey:'height in'},
};

const SPECS_SKIP = new Set(['length in','span in','height in','ref','prime units?','genhide','perfhide','armhide']);

const extractTemplateParams = (wikitext: string, re: RegExp): Record<string, string> => {
  const m = wikitext.match(re);
  if (!m || m.index === undefined) return {};
  let depth = 0, end = m.index;
  for (let i = m.index; i < wikitext.length - 1; i++) {
    if (wikitext[i] === '{' && wikitext[i + 1] === '{') { depth++; i++; }
    else if (wikitext[i] === '}' && wikitext[i + 1] === '}') {
      depth--; if (depth === 0) { end = i + 2; break; } i++;
    }
  }
  const body = wikitext.slice(m.index + 2, end - 2);
  const parts: string[] = [];
  let seg = 0, d = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if ((c === '{' && body[i + 1] === '{') || (c === '[' && body[i + 1] === '[')) { d++; i++; }
    else if ((c === '}' && body[i + 1] === '}') || (c === ']' && body[i + 1] === ']')) { d--; i++; }
    else if (c === '|' && d === 0) { parts.push(body.slice(seg, i).trim()); seg = i + 1; }
  }
  parts.push(body.slice(seg).trim());
  const raw: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq === -1) continue;
    const key = parts[i].slice(0, eq).trim().toLowerCase();
    const val = parts[i].slice(eq + 1).trim();
    if (key && val) raw[key] = val;
  }
  return raw;
};

export const mapAircraftSpecs = (wikitext: string): Record<string, string> => {
  const raw = extractTemplateParams(wikitext, /\{\{[Aa]ircraft\s+specs\b/);
  if (!Object.keys(raw).length) return {};
  const result: Record<string, string> = {};

  for (const [ftKey, { param, inKey }] of Object.entries(FT_IN_PAIRS)) {
    const ftVal = raw[ftKey];
    if (!ftVal) continue;
    const ft = cleanWikiValue(ftVal);
    const inch = raw[inKey] ? cleanWikiValue(raw[inKey]) : '';
    if (!result[param]) result[param] = inch && inch !== '0' ? `${addCommas(ft)} ft ${inch} in` : `${addCommas(ft)} ft`;
  }

  for (const [rawKey, rawVal] of Object.entries(raw)) {
    if (SPECS_SKIP.has(rawKey)) continue;
    const def = AIRCRAFT_SPECS_MAP[rawKey];
    if (def) {
      if (result[def.param]) continue;
      const cleaned = cleanWikiValue(rawVal);
      if (!cleaned) continue;
      if (def.prefix) result[def.param] = `${def.prefix}${cleaned}`;
      else if (def.unit) result[def.param] = `${addCommas(cleaned)} ${def.unit}`;
      else result[def.param] = cleaned;
    } else {
      const camelKey = toCamelCase(rawKey);
      if (result[camelKey]) continue;
      const cleaned = cleanWikiValue(rawVal);
      if (cleaned) result[camelKey] = cleaned;
    }
  }

  if (result['numberOfEngines'] && result['engineType'])
    result['engineType'] = `${result['numberOfEngines']} × ${result['engineType']}`;

  const rawArmament = raw['armament'] || raw['weapons'] || '';
  if (rawArmament) {
    const lines = rawArmament.split('\n').map((l: string) => l.replace(/^[*#:]+\s*/, '').trim()).filter(Boolean);
    if (!result['guns']) {
      const g = lines.find((l: string) => /''Guns?''|Gun[s]?:/i.test(l));
      if (g) result['guns'] = cleanWikiValue(g.replace(/.*(?:Guns?:|''Guns?'')\s*/i, ''));
    }
    if (!result['missiles']) {
      const ml = lines.filter((l: string) => /AIM-|AGM-|AMRAAM|Sidewinder|IRIS-T|Python|R-73|MICA|Meteor|ASRAAM/i.test(l));
      if (ml.length) result['missiles'] = cleanWikiValue(ml.slice(0, 4).join('; '));
    }
    if (!result['bombs']) {
      const bl = lines.filter((l: string) => /JDAM|GBU-|SDB|Paveway|CBU-|bomb|munition|StormBreaker/i.test(l));
      if (bl.length) result['bombs'] = cleanWikiValue(bl.slice(0, 4).join('; '));
    }
    if (!result['hardpoints']) {
      const hl = lines.find((l: string) => /hardpoint|pylon|station|bays?/i.test(l) && /\d/.test(l));
      if (hl) result['hardpoints'] = cleanWikiValue(hl);
    }
  }

  if (!result['radar'] && result['avionics']) {
    const rl = result['avionics'].split(',').find((s: string) => /radar|APG|APY|APQ|AESA|RBE|CAPTOR/i.test(s));
    if (rl) result['radar'] = rl.trim();
  }

  return result;
};

// ── HTML fallback ─────────────────────────────────────────────────────────────
const HTML_LABEL_MAP: Record<string, string[]> = {
  role:['Role','Type','Function'],manufacturer:['Manufacturer','Builder'],
  designer:['Designer','Designed by'],countryOfOrigin:['National origin','Country of origin','Origin'],
  firstFlight:['First flight','First flown'],serviceEntry:['Introduced','Entered service'],
  status:['Status'],numberBuilt:['Number built','Units built'],primaryUser:['Primary user','Operators'],
  length:['Length'],wingspan:['Wingspan','Span'],height:['Height'],wingArea:['Wing area'],
  emptyWeight:['Empty weight'],maxTakeoffWeight:['Maximum takeoff weight','MTOW'],
  maxSpeed:['Maximum speed','Max speed'],range:['Range'],serviceCeiling:['Service ceiling'],
  engineType:['Powerplant','Engine'],crew:['Crew'],armament:['Armament'],
  passengerCapacity:['Passengers','Capacity'],
};

export const parseHtmlFallback = (html: string, missing: string[]): Record<string, string> => {
  const $ = cheerio.load(html);
  const rows: Record<string, string> = {};
  $('table.infobox').each((_, tbl) => {
    $(tbl).find('tr').each((_, row) => {
      const th = $(row).find('th').first();
      const td = $(row).find('td').first();
      if (!th.length || !td.length) return;
      const label = th.text().replace(/\[.*?\]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
      const val = td.text().replace(/\[.*?\]/g, '').replace(/\s+/g, ' ').trim();
      if (label && val && !rows[label]) rows[label] = val;
    });
  });
  const result: Record<string, string> = {};
  missing.forEach(field => {
    const labels = HTML_LABEL_MAP[field] || [];
    for (const label of labels) {
      const v = rows[label.toLowerCase()];
      if (v) { result[field] = v; return; }
    }
  });
  return result;
};

// ── Page finder ───────────────────────────────────────────────────────────────
const pageTitleCache = new Map<string, string>();

export const findAircraftPage = async (name: string): Promise<string> => {
  const key = name.toLowerCase();
  if (pageTitleCache.has(key)) return pageTitleCache.get(key)!;
  const enc = encodeURIComponent;
  const base = `https://en.wikipedia.org/w/api.php?action=query&list=search&srlimit=3&format=json&srnamespace=0&srprop=`;
  const [r1, r2] = await Promise.allSettled([
    wikiGet(`${base}&srsearch=${enc(name + ' hastemplate:"Infobox aircraft"')}`),
    wikiGet(`${base}&srsearch=${enc(name + ' hastemplate:"Infobox weapon"')}`),
  ]);
  const candidates: string[] = [
    ...(r1.status === 'fulfilled' ? (r1.value.data.query?.search || []).map((h: any) => h.title) : []),
    ...(r2.status === 'fulfilled' ? (r2.value.data.query?.search || []).map((h: any) => h.title) : []),
  ].filter((t, i, a) => t && a.indexOf(t) === i);
  const best = candidates.find(t => t.toLowerCase().includes(name.toLowerCase())) || candidates[0] || name;
  pageTitleCache.set(key, best);
  return best;
};

export const fetchWikitext = async (title: string): Promise<string | null> => {
  const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=revisions&rvprop=content&rvslots=main&format=json&redirects=1`;
  const res = await wikiGet(url);
  const pages = res.data.query?.pages || {};
  const page: any = Object.values(pages)[0];
  return page?.revisions?.[0]?.slots?.main?.['*'] || page?.revisions?.[0]?.['*'] || null;
};

export const fetchHtml = async (title: string): Promise<string | null> => {
  const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(title)}&prop=text&format=json&redirects=1`;
  const res = await wikiGet(url);
  return res.data.parse?.text?.['*'] || null;
};

export const ALL_KNOWN_PARAMS = Array.from(new Set([
  ...Object.values(UNIFIED_INFOBOX_KEY_MAP),
  ...Object.values(AIRCRAFT_SPECS_MAP).map((d: SpecDef) => d.param),
]));
