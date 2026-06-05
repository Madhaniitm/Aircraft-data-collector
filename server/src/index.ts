import express, { Request, Response } from 'express';
import cors from 'cors';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as cheerio from 'cheerio';

const app = express();
app.use(cors());
app.use(express.json());

// ── Wikipedia rate-limit–safe request queue ───────────────────────────────────
// Wikipedia allows ~200 req/min. We cap at 3 req/sec (180/min) with a FIFO queue.
// All Wikipedia API calls go through wikiGet() instead of axios.get() directly.

// ── Wikipedia request helper with automatic 429 retry ─────────────────────────
// No global queue — that causes slowness for all users.
// Instead: fire requests immediately, retry with Retry-After backoff on 429.
// Wikipedia's actual soft limit is ~200 req/min; normal concurrent usage won't hit it.

const wikiGet = async (url: string): Promise<any> => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await axios.get(url, UA_OBJ);
    } catch (e: any) {
      if (e?.response?.status === 429) {
        const retryAfter = parseInt(e.response.headers?.['retry-after'] || '5', 10);
        const wait = Math.max(retryAfter * 1000, Math.pow(2, attempt) * 1000);
        console.warn(`429 — waiting ${wait}ms before retry ${attempt + 1}`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw e;
      }
    }
  }
  throw new Error('Wikipedia API unavailable after retries');
};

const UA_OBJ = { headers: { 'User-Agent': 'AircraftDataCollector/1.0 (research tool)' } };

// ─── Helpers ────────────────────────────────────────────────────────────────

const addCommas = (n: string) =>
  n.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Strip wikitext markup and return clean plain text */
const cleanWikiValue = (raw: string): string => {
  let v = raw;
  // Strip citation refs first (they contain | inside and confuse later steps)
  v = v.replace(/<ref[^>]*\/>/gi, '');
  v = v.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');
  // {{convert|val|unit|…}} / {{cvt|val|unit|…}} → "val unit"
  v = v.replace(/\{\{(?:convert|cvt)\|([^|{}]+)\|([^|{}]+)[^{}]*\}\}/gi, '$1 $2');
  // {{start date and age|YYYY|MM|DD|…}} → "YYYY-MM-DD"
  v = v.replace(/\{\{[Ss]tart[\s_][Dd]ate[\w\s]*\|(\d{4})\|(\d{1,2})\|(\d{1,2})[^}]*\}\}/g, '$1-$2-$3');
  v = v.replace(/\{\{[Ss]tart[\s_][Dd]ate[\w\s]*\|(\d{4})[^}]*\}\}/g, '$1');
  // {{ubl|a|b|c}} / {{unbulleted list|…}} / {{plainlist|…}} → "a, b, c"
  v = v.replace(/\{\{(?:ubl|plainlist|flat\s*list|unbulleted\s+list|hlist)[^|{]*\|([\s\S]*?)\}\}/gi,
    (_, body) => {
      const items = body.split('|').map((s: string) =>
        s.replace(/\*+/g, '').replace(/\[\[(?:[^\]|]+\|)?([^\]]+)\]\]/g, '$1').trim()
      ).filter(Boolean);
      return items.join(', ');
    }
  );
  // {{flag|X}} / {{flagcountry|X}} → X
  v = v.replace(/\{\{flag(?:country|icon|deco)?\|([^|{}]+)[^{}]*\}\}/gi, '$1');
  // [[link|text]] or [[text]] → text
  v = v.replace(/\[\[(?:[^\]|]+\|)?([^\]]+)\]\]/g, '$1');
  // Remove remaining templates (iterate for nesting)
  let prev = '';
  while (prev !== v) { prev = v; v = v.replace(/\{\{[^{}]*\}\}/g, ''); }
  // Wiki bold/italic markers
  v = v.replace(/'{2,3}/g, '');
  // <br> → ", "
  v = v.replace(/<br\s*\/?>/gi, ', ');
  // HTML tags (preserve content between tags)
  v = v.replace(/<[^>]+>/g, ' ');
  // Wiki citation markers [1], [note 3]
  v = v.replace(/\[[\w\s]+\]/g, '');
  // Bullet markers (* ** ***) at start of lines
  v = v.replace(/^\s*\*+\s*/gm, '').replace(/\n+/g, ', ');
  // Normalise
  v = v.replace(/,\s*,+/g, ',').replace(/\s+/g, ' ').replace(/^[,\s]+|[,\s]+$/g, '').trim();
  return v;
};

// ─── Unified infobox key map ─────────────────────────────────────────────────
// Covers ALL Wikipedia aircraft/weapon/vehicle infobox templates generically.
// Priority order in fetch: Aircraft specs (most accurate) → these (fill gaps).

const UNIFIED_INFOBOX_KEY_MAP: Record<string, string> = {
  // Role / type — any infobox
  type: 'role', role: 'role', function: 'role', classification: 'role',
  aircraft_type: 'role', is_missile: 'role', primary_function: 'role',

  // Identity
  manufacturer: 'manufacturer', 'manufacturer(s)': 'manufacturer', builder: 'manufacturer',
  designer: 'designer', designed_by: 'designer', chief_designer: 'designer',
  national_origin: 'countryOfOrigin', origin: 'countryOfOrigin',
  country: 'countryOfOrigin', country_of_origin: 'countryOfOrigin',
  designation: 'designation', model: 'designation',
  variants: 'variants', developed_into: 'variants',

  // History
  first_flight: 'firstFlight', maiden_flight: 'firstFlight',
  introduction: 'serviceEntry', introduced: 'serviceEntry',
  entered_service: 'serviceEntry', in_service: 'serviceEntry',
  service_entry: 'serviceEntry',
  retired: 'retired', retirement: 'retired',
  status: 'status', production_status: 'status',
  number_built: 'numberBuilt', produced: 'numberBuilt',
  units_built: 'numberBuilt', number: 'numberBuilt',
  primary_user: 'primaryUser', primary_users: 'primaryUser',
  operators: 'primaryUser', used_by: 'primaryUser', users: 'primaryUser',

  // Dimensions
  wingspan: 'wingspan', span: 'wingspan', wing_span: 'wingspan',
  length: 'length', overall_length: 'length',
  height: 'height', overall_height: 'height',
  width: 'fuselageWidth', fuselage_width: 'fuselageWidth',
  fuselage_diameter: 'fuselageWidth',
  wing_area: 'wingArea', area: 'wingArea',
  aspect_ratio: 'aspectRatio',
  rotor_diameter: 'rotorDiameter', main_rotor_diameter: 'rotorDiameter',
  cabin_length: 'cabinLength', cabin_width: 'cabinWidth', cabin_height: 'cabinHeight',

  // Weight — note: for missiles 'weight' = launch weight ≈ gross weight
  empty_weight: 'emptyWeight', weight_empty: 'emptyWeight',
  operating_empty_weight: 'emptyWeight',
  gross_weight: 'grossWeight', normal_takeoff_weight: 'grossWeight',
  weight: 'grossWeight',               // missiles/drones: launch weight
  max_takeoff_weight: 'maxTakeoffWeight', maximum_takeoff_weight: 'maxTakeoffWeight',
  max_weight: 'maxTakeoffWeight', mtow: 'maxTakeoffWeight',
  fuel_capacity: 'fuelCapacity', internal_fuel: 'fuelCapacity',
  payload: 'maxPayload', payload_capacity: 'maxPayload', max_payload: 'maxPayload',
  useful_load: 'maxPayload',

  // Performance
  maximum_speed: 'maxSpeed', max_speed: 'maxSpeed', speed: 'maxSpeed',
  top_speed: 'maxSpeed', never_exceed_speed: 'maxSpeed',
  cruise_speed: 'cruiseSpeed', cruising_speed: 'cruiseSpeed',
  stall_speed: 'stallSpeed',
  range: 'range', vehicle_range: 'range', maximum_range: 'range',
  ferry_range: 'ferryRange', maximum_ferry_range: 'ferryRange',
  combat_range: 'combatRange', combat_radius: 'combatRange',
  effective_range: 'combatRange', action_radius: 'combatRange',
  service_ceiling: 'serviceCeiling', ceiling: 'serviceCeiling',
  altitude: 'serviceCeiling', maximum_altitude: 'serviceCeiling',
  rate_of_climb: 'rateOfClimb', climb_rate: 'rateOfClimb',
  wing_loading: 'wingLoading',
  thrust_to_weight: 'thrustToWeight', power_to_weight: 'thrustToWeight',
  g_limits: 'gLimits', load_factor: 'gLimits',
  endurance: 'endurance',
  takeoff_run: 'takeoffRun', landing_run: 'landingRun',
  mach: 'machNumber', maximum_mach: 'machNumber',

  // Powerplant
  powerplant: 'engineType', engine: 'engineType', engines: 'engineType',
  propulsion: 'engineType', power_plant: 'engineType',
  thrust: 'thrust', rated_thrust: 'thrust',
  thrust_ab: 'thrustWithAfterburner', afterburning_thrust: 'thrustWithAfterburner',
  power: 'powerOutput', power_output: 'powerOutput', horsepower: 'powerOutput',
  propeller: 'propeller', rotor: 'propeller',

  // Military / armament
  crew: 'crew', pilots: 'crew', aircrew: 'crew',
  armament: 'armament', weapons: 'armament',
  warhead: 'armament', filling: 'bombs',
  guns: 'guns', cannon: 'guns',
  missiles: 'missiles', rockets: 'missiles',
  bombs: 'bombs', bomb_load: 'bombs',
  hardpoints: 'hardpoints', hardpoint_capacity: 'hardpoints',
  avionics: 'avionics', electronics: 'avionics', guidance: 'avionics',
  radar: 'radar',

  // Civil / commercial
  passengers: 'passengerCapacity', capacity: 'passengerCapacity',
  seating: 'passengerCapacity', accommodation: 'passengerCapacity',
  cargo_capacity: 'cargoCapacity', cargo: 'cargoCapacity',
  icao_code: 'icaoCode', iata_code: 'iataCode',
  certification: 'certification',
  fly_by_wire: 'flyByWire',
};

/** Convert snake_case / space-case → camelCase */
const toCamelCase = (key: string): string =>
  key.toLowerCase().replace(/[-_\s]+(.)/g, (_, c) => c.toUpperCase());

// Only skip truly useless template-control fields (no data value for the aircraft)
const ALWAYS_SKIP = new Set([
  'image','image_size','image_alt','imagewidth','image_caption',
  'caption','alt','logo','map','map_caption','thumbnail',
  'ref','prime_units?','genhide','perfhide','armhide',
]);

/** Extract all key→value pairs from a template body (pipe-split at depth 0) */
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

/**
 * Extracts EVERY key=value pair from EVERY {{Infobox...}} template on the page.
 * Nothing filtered. Known keys get a clean camelCase name via UNIFIED_INFOBOX_KEY_MAP,
 * unknown keys are auto-converted to camelCase — all data comes through.
 */
const extractAllInfoboxes = (wikitext: string): Record<string, string> => {
  const result: Record<string, string> = {};
  const infoboxRe = /\{\{[Ii]nfobox\b/g;
  let m: RegExpExecArray | null;

  while ((m = infoboxRe.exec(wikitext)) !== null) {
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

      // Prefer our mapped key name (nicer), fall back to auto camelCase
      const key = UNIFIED_INFOBOX_KEY_MAP[rawKey] || toCamelCase(rawKey);
      if (result[key]) continue;

      const cleaned = cleanWikiValue(rawVal);
      if (cleaned) result[key] = cleaned;
    }
  }
  return result;
};

// ─── Parse {{Aircraft specs}} ────────────────────────────────────────────────
// All technical specs live here with a very specific key convention.
// Dimensions are split into ft+in or m; performance into kts/mach/mph/kmh; etc.

interface SpecDef { param: string; unit?: string; prefix?: string }
const AIRCRAFT_SPECS_MAP: Record<string, SpecDef> = {
  crew:                 { param: 'crew' },
  capacity:             { param: 'passengerCapacity' },

  // Dimensions — primary unit only (ft wins; m used if ft absent)
  'length ft':          { param: 'length', unit: 'ft' },
  'length m':           { param: 'length', unit: 'm' },
  'span ft':            { param: 'wingspan', unit: 'ft' },
  'span m':             { param: 'wingspan', unit: 'm' },
  'height ft':          { param: 'height', unit: 'ft' },
  'height m':           { param: 'height', unit: 'm' },
  'wing area sqft':     { param: 'wingArea', unit: 'sq ft' },
  'wing area sqm':      { param: 'wingArea', unit: 'm²' },
  'aspect ratio':       { param: 'aspectRatio' },
  'rotor diameter ft':  { param: 'rotorDiameter', unit: 'ft' },
  'rotor diameter m':   { param: 'rotorDiameter', unit: 'm' },
  'disc area sqft':     { param: 'rotorDiameter', unit: 'sq ft' },

  // Weight
  'empty weight lb':        { param: 'emptyWeight', unit: 'lb' },
  'empty weight kg':        { param: 'emptyWeight', unit: 'kg' },
  'gross weight lb':        { param: 'grossWeight', unit: 'lb' },
  'gross weight kg':        { param: 'grossWeight', unit: 'kg' },
  'max takeoff weight lb':  { param: 'maxTakeoffWeight', unit: 'lb' },
  'max takeoff weight kg':  { param: 'maxTakeoffWeight', unit: 'kg' },
  'fuel capacity':          { param: 'fuelCapacity' },
  'payload lb':             { param: 'maxPayload', unit: 'lb' },
  'payload kg':             { param: 'maxPayload', unit: 'kg' },

  // Engines
  'eng1 name':       { param: 'engineType' },
  'eng1 type':       { param: 'engineType' },
  'eng1 number':     { param: 'numberOfEngines' },
  'eng1 lbf':        { param: 'thrust', unit: 'lbf' },
  'eng1 kn':         { param: 'thrust', unit: 'kN' },
  'eng1 lbf-ab':     { param: 'thrustWithAfterburner', unit: 'lbf' },
  'eng1 kn-ab':      { param: 'thrustWithAfterburner', unit: 'kN' },
  'eng1 hp':         { param: 'powerOutput', unit: 'hp' },
  'eng1 kw':         { param: 'powerOutput', unit: 'kW' },
  'eng1 shp':        { param: 'powerOutput', unit: 'shp' },

  // Speed — prefer mach > kts > mph > kmh for max speed
  'max speed mach':         { param: 'maxSpeed', prefix: 'Mach ' },
  'max speed kts':          { param: 'maxSpeed', unit: 'kn' },
  'max speed mph':          { param: 'maxSpeed', unit: 'mph' },
  'max speed kmh':          { param: 'maxSpeed', unit: 'km/h' },
  'never exceed speed kts': { param: 'maxSpeed', unit: 'kn' },
  'cruise speed kts':       { param: 'cruiseSpeed', unit: 'kn' },
  'cruise speed mph':       { param: 'cruiseSpeed', unit: 'mph' },
  'cruise speed kmh':       { param: 'cruiseSpeed', unit: 'km/h' },
  'stall speed kts':        { param: 'stallSpeed', unit: 'kn' },
  'stall speed mph':        { param: 'stallSpeed', unit: 'mph' },

  // Range
  'range nmi':          { param: 'range', unit: 'nmi' },
  'range miles':        { param: 'range', unit: 'mi' },
  'range km':           { param: 'range', unit: 'km' },
  'combat range nmi':   { param: 'combatRange', unit: 'nmi' },
  'combat range miles': { param: 'combatRange', unit: 'mi' },
  'combat range km':    { param: 'combatRange', unit: 'km' },
  'ferry range nmi':    { param: 'ferryRange', unit: 'nmi' },
  'ferry range miles':  { param: 'ferryRange', unit: 'mi' },
  'ferry range km':     { param: 'ferryRange', unit: 'km' },
  endurance:            { param: 'endurance' },

  // Ceiling / climb / loading
  'ceiling ft':         { param: 'serviceCeiling', unit: 'ft' },
  'ceiling m':          { param: 'serviceCeiling', unit: 'm' },
  'climb rate ftmin':   { param: 'rateOfClimb', unit: 'ft/min' },
  'climb rate ms':      { param: 'rateOfClimb', unit: 'm/s' },
  'wing loading lb/sqft': { param: 'wingLoading', unit: 'lb/sq ft' },
  'wing loading kg/m2':   { param: 'wingLoading', unit: 'kg/m²' },
  'thrust/weight':      { param: 'thrustToWeight' },
  'g limits':           { param: 'gLimits' },

  // Armament
  armament:               { param: 'armament' },   // F-22, F-35 etc. use combined armament key
  weapons:                { param: 'armament' },
  guns:                   { param: 'guns' },
  hardpoints:             { param: 'hardpoints' },
  'hardpoint capacity':   { param: 'hardpoints' },
  rockets:                { param: 'missiles' },
  missiles:               { param: 'missiles' },
  'hardpoint missiles':   { param: 'missiles' },
  bombs:                  { param: 'bombs' },
  'hardpoint bombs':      { param: 'bombs' },
  'hardpoint other':      { param: 'armament' },
  avionics:               { param: 'avionics' },
  radar:                  { param: 'radar' },

  // Helicopter-specific
  'rot dia m':            { param: 'rotorDiameter', unit: 'm' },
  'rot dia ft':           { param: 'rotorDiameter', unit: 'ft' },
  'rot area sqft':        { param: 'wingArea', unit: 'sq ft' },
  'rot area sqm':         { param: 'wingArea', unit: 'm²' },
  'disk loading lb/sqft': { param: 'wingLoading', unit: 'lb/sq ft' },
  'disk loading kg/m2':   { param: 'wingLoading', unit: 'kg/m²' },
  'power/mass':           { param: 'thrustToWeight' },

  // Speed note fallback (some articles put speed only in the note field)
  'max speed note':       { param: 'maxSpeed' },
  'cruise speed note':    { param: 'cruiseSpeed' },
};

// Pairs where we combine ft + in into a single string
const FT_IN_PAIRS: Record<string, { param: string; inKey: string }> = {
  'length ft':  { param: 'length', inKey: 'length in' },
  'span ft':    { param: 'wingspan', inKey: 'span in' },
  'height ft':  { param: 'height', inKey: 'height in' },
};

/** Extract all template params as a flat key→value map */
const extractTemplateParams = (wikitext: string, templateRe: RegExp): Record<string, string> => {
  const m = wikitext.match(templateRe);
  if (!m || m.index === undefined) return {};

  let depth = 0, end = m.index;
  for (let i = m.index; i < wikitext.length - 1; i++) {
    if (wikitext[i] === '{' && wikitext[i + 1] === '{') { depth++; i++; }
    else if (wikitext[i] === '}' && wikitext[i + 1] === '}') {
      depth--;
      if (depth === 0) { end = i + 2; break; }
      i++;
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


/** Map {{Aircraft specs}} params → our keys, combining ft+in pairs */
const mapAircraftSpecs = (wikitext: string): Record<string, string> => {
  const raw = extractTemplateParams(wikitext, /\{\{[Aa]ircraft\s+specs\b/);
  if (!Object.keys(raw).length) return {};

  const result: Record<string, string> = {};

  // First pass: handle ft+in combinations
  for (const [ftKey, { param, inKey }] of Object.entries(FT_IN_PAIRS)) {
    const ftVal = raw[ftKey];
    if (!ftVal) continue;
    const inVal = raw[inKey];
    const ft = cleanWikiValue(ftVal);
    const inch = inVal ? cleanWikiValue(inVal) : '';
    if (!result[param]) {
      result[param] = inch && inch !== '0'
        ? `${addCommas(ft)} ft ${inch} in`
        : `${addCommas(ft)} ft`;
    }
  }

  // Only skip the "in" halves already merged above, and pure template controls
  const SPECS_SKIP = new Set(['length in','span in','height in','ref','prime units?','genhide','perfhide','armhide']);

  // Second pass: every remaining key
  for (const [rawKey, rawVal] of Object.entries(raw)) {
    if (SPECS_SKIP.has(rawKey)) continue;

    const def = AIRCRAFT_SPECS_MAP[rawKey];

    if (def) {
      // Known key — nice param name + unit handling
      if (result[def.param]) continue;
      const cleaned = cleanWikiValue(rawVal);
      if (!cleaned) continue;
      if (def.prefix) result[def.param] = `${def.prefix}${cleaned}`;
      else if (def.unit) result[def.param] = `${addCommas(cleaned)} ${def.unit}`;
      else result[def.param] = cleaned;
    } else {
      // Unknown key — still include it, auto camelCase
      const camelKey = toCamelCase(rawKey);
      if (result[camelKey]) continue;
      const cleaned = cleanWikiValue(rawVal);
      if (cleaned) result[camelKey] = cleaned;
    }
  }

  // Combine eng1 number + eng1 name into engineType
  if (result['numberOfEngines'] && result['engineType']) {
    result['engineType'] = `${result['numberOfEngines']} × ${result['engineType']}`;
  }

  // ── Post-process: extract sub-fields from combined armament (raw wikitext) ──
  // Many aircraft (F-22, F-35, Rafale…) put guns/missiles/bombs/hardpoints
  // all inside one "armament" field. Parse the RAW value before cleanWikiValue.
  const rawArmament = raw['armament'] || raw['weapons'] || '';
  if (rawArmament) {
    const lines = rawArmament.split('\n').map(l => l.replace(/^[*#:]+\s*/, '').trim()).filter(Boolean);

    if (!result['guns']) {
      const gunsLine = lines.find(l => /''Guns?''|Gun[s]?:/i.test(l));
      if (gunsLine) {
        const after = gunsLine.replace(/.*(?:Guns?:|''Guns?'')\s*/i, '');
        result['guns'] = cleanWikiValue(after);
      }
    }

    if (!result['missiles']) {
      // Collect lines mentioning missile designations
      const missileLines = lines.filter(l =>
        /AIM-|AGM-|AMRAAM|Sidewinder|IRIS-T|Python|R-73|MICA|Meteor|ASRAAM|Derby|JATM|Sparrow/i.test(l)
      );
      if (missileLines.length > 0)
        result['missiles'] = cleanWikiValue(missileLines.slice(0, 4).join('; '));
    }

    if (!result['bombs']) {
      const bombLines = lines.filter(l =>
        /JDAM|GBU-|SDB|Paveway|CBU-|bomb|munition|JSOW|WCMD|StormBreaker/i.test(l)
      );
      if (bombLines.length > 0)
        result['bombs'] = cleanWikiValue(bombLines.slice(0, 4).join('; '));
    }

    if (!result['hardpoints']) {
      const hpLine = lines.find(l => /hardpoint|pylon|station|bays?/i.test(l) && /\d/.test(l));
      if (hpLine) result['hardpoints'] = cleanWikiValue(hpLine);
    }
  }

  // Extract radar from avionics when no dedicated radar key exists
  if (!result['radar'] && result['avionics']) {
    const radarLine = result['avionics']
      .split(',')
      .find(s => /radar|APG|APY|APQ|AESA|RBE|CAPTOR|Zhuk|Irbis/i.test(s));
    if (radarLine) result['radar'] = radarLine.trim();
  }

  return result;
};

// ─── HTML fallback (for gaps after wikitext parsing) ─────────────────────────

const HTML_LABEL_MAP: Record<string, string[]> = {
  role:               ['Role', 'Type', 'Function', 'Primary function', 'Aircraft type'],
  manufacturer:       ['Manufacturer', 'Manufacturer(s)', 'Builder'],
  designer:           ['Designer', 'Designed by'],
  countryOfOrigin:    ['National origin', 'Country of origin', 'Origin'],
  designation:        ['Designation', 'Model'],
  variants:           ['Variants', 'Variants/Derivatives'],
  firstFlight:        ['First flight', 'First flown', 'Maiden flight'],
  serviceEntry:       ['Introduced', 'Entered service', 'Service entry'],
  retired:            ['Retired', 'Decommissioned'],
  status:             ['Status', 'Production status'],
  numberBuilt:        ['Number built', 'Units built', 'Number produced', 'Produced'],
  primaryUser:        ['Primary user', 'Primary users', 'Operators', 'Users'],
  length:             ['Length', 'Length overall'],
  wingspan:           ['Wingspan', 'Span'],
  wingArea:           ['Wing area'],
  height:             ['Height'],
  emptyWeight:        ['Empty weight', 'Operating empty weight'],
  grossWeight:        ['Gross weight', 'Normal takeoff weight'],
  maxTakeoffWeight:   ['Maximum takeoff weight', 'Max. takeoff weight', 'MTOW'],
  fuelCapacity:       ['Fuel capacity', 'Internal fuel'],
  maxPayload:         ['Payload', 'Maximum payload'],
  maxSpeed:           ['Maximum speed', 'Max speed', 'Top speed', 'Never-exceed speed'],
  cruiseSpeed:        ['Cruise speed', 'Cruising speed'],
  stallSpeed:         ['Stall speed'],
  range:              ['Range', 'Maximum range'],
  ferryRange:         ['Ferry range'],
  combatRange:        ['Combat range', 'Combat radius'],
  serviceCeiling:     ['Service ceiling', 'Ceiling'],
  rateOfClimb:        ['Rate of climb', 'Climb rate'],
  wingLoading:        ['Wing loading'],
  thrustToWeight:     ['Thrust/weight', 'Thrust-to-weight ratio'],
  gLimits:            ['g limits', 'G limits'],
  endurance:          ['Endurance'],
  engineType:         ['Powerplant', 'Engine', 'Engines'],
  numberOfEngines:    ['Number of engines'],
  thrust:             ['Thrust', 'Maximum thrust'],
  thrustWithAfterburner: ['Thrust with afterburner', 'Afterburning thrust'],
  powerOutput:        ['Power output', 'Power'],
  crew:               ['Crew', 'Pilots'],
  armament:           ['Armament', 'Weapons'],
  hardpoints:         ['Hardpoints', 'Hardpoint capacity'],
  guns:               ['Guns', 'Cannon'],
  missiles:           ['Missiles', 'Rockets'],
  bombs:              ['Bombs', 'Bomb load'],
  radar:              ['Radar', 'Fire-control radar'],
  avionics:           ['Avionics'],
  operators:          ['Operators', 'Current operators'],
  passengerCapacity:  ['Passengers', 'Seating capacity', 'Capacity', 'Seats'],
  cargoCapacity:      ['Cargo capacity', 'Cargo'],
  icaoCode:           ['ICAO code', 'ICAO type designator'],
  iataCode:           ['IATA code'],
  certification:      ['Certification', 'Type certificate'],
  flyByWire:          ['Fly-by-wire', 'Flight control system'],
};

/**
 * Prose extraction — scan the article body paragraphs for specs that are
 * written in plain text rather than in a structured template.
 * e.g. "…reaches a maximum speed of Mach 2.05 at altitude…"
 */
const PROSE_PATTERNS: Record<string, { re: RegExp; fmt: (m: RegExpMatchArray) => string }[]> = {
  maxSpeed: [
    { re: /max(?:imum)?\s+speed[^.]{0,60}?(Mach\s*[\d.]+)/i,              fmt: m => m[1] },
    { re: /(Mach\s*[\d.]+)[^.]{0,40}?speed/i,                              fmt: m => m[1] },
    { re: /max(?:imum)?\s+speed[^.]{0,60}?([\d,]+)\s*(km\/h|mph|knots?)\b/i, fmt: m => `${m[1]} ${m[2]}` },
  ],
  cruiseSpeed: [
    { re: /cruise[^.]{0,50}?([\d,]+)\s*(km\/h|mph|kn|knots?)\b/i,         fmt: m => `${m[1]} ${m[2]}` },
  ],
  range: [
    { re: /range[^.]{0,50}?([\d,]+)\s*(km|nmi|nautical miles?|miles?)\b/i, fmt: m => `${m[1]} ${m[2]}` },
  ],
  ferryRange: [
    { re: /ferry range[^.]{0,50}?([\d,]+)\s*(km|nmi|nautical miles?|miles?)\b/i, fmt: m => `${m[1]} ${m[2]}` },
  ],
  combatRange: [
    { re: /combat range[^.]{0,50}?([\d,]+)\s*(km|nmi|nautical miles?|miles?)\b/i, fmt: m => `${m[1]} ${m[2]}` },
    { re: /combat radius[^.]{0,50}?([\d,]+)\s*(km|nmi|nautical miles?|miles?)\b/i, fmt: m => `${m[1]} ${m[2]}` },
  ],
  serviceCeiling: [
    { re: /service ceiling[^.]{0,50}?([\d,]+)\s*(ft|m|feet|metres?)\b/i,  fmt: m => `${m[1]} ${m[2]}` },
    { re: /ceiling[^.]{0,50}?([\d,]+)\s*(ft|m|feet|metres?)\b/i,          fmt: m => `${m[1]} ${m[2]}` },
  ],
  rateOfClimb: [
    { re: /rate of climb[^.]{0,50}?([\d,]+)\s*(ft\/min|m\/s|m\/min|fpm)\b/i, fmt: m => `${m[1]} ${m[2]}` },
  ],
  maxTakeoffWeight: [
    { re: /(?:MTOW|max(?:imum)?\s+take.?off weight)[^.]{0,50}?([\d,]+)\s*(kg|lb|t)\b/i, fmt: m => `${m[1]} ${m[2]}` },
  ],
  emptyWeight: [
    { re: /empty weight[^.]{0,50}?([\d,]+)\s*(kg|lb)\b/i,                 fmt: m => `${m[1]} ${m[2]}` },
  ],
  wingspan: [
    { re: /wingspan[^.]{0,50}?([\d.]+)\s*(m|ft|feet|metres?)\b/i,         fmt: m => `${m[1]} ${m[2]}` },
  ],
  length: [
    { re: /length[^.]{0,50}?([\d.]+)\s*(m|ft|feet|metres?)\b/i,           fmt: m => `${m[1]} ${m[2]}` },
  ],
  crew: [
    { re: /crew\s+of\s+(\d+)/i,                                            fmt: m => m[1] },
    { re: /crewed by\s+(\d+)/i,                                            fmt: m => m[1] },
  ],
  engineType: [
    { re: /powered by\s+([^,.]{5,60}(?:engine|turbofan|turbojet|turboprop|piston))/i, fmt: m => m[1].trim() },
  ],
  thrust: [
    { re: /thrust[^.]{0,50}?([\d,]+)\s*(kN|lbf|lb)\b/i,                  fmt: m => `${m[1]} ${m[2]}` },
  ],
  passengerCapacity: [
    { re: /(?:seats?|passengers?|capacity)\s+(?:of\s+|up to\s+)?(\d+)/i,  fmt: m => m[1] },
    { re: /(\d+)\s+passengers?\b/i,                                         fmt: m => `${m[1]} passengers` },
  ],
  numberBuilt: [
    { re: /(\d[\d,]+)\s+(?:aircraft|units?|examples?)\s+(?:were\s+)?(?:built|produced|delivered)/i, fmt: m => m[1] },
    { re: /(?:built|produced)\s+(\d[\d,]+)\s+(?:aircraft|units?)/i,       fmt: m => m[1] },
  ],
  firstFlight: [
    { re: /first (?:flew|flight|flown)[^.]{0,60}?(\d{1,2}\s+\w+\s+\d{4}|\w+\s+\d{1,2},?\s+\d{4}|\d{4})/i, fmt: m => m[1] },
  ],
};

const extractFromProse = (html: string, missing: string[]): Record<string, string> => {
  const $ = cheerio.load(html);
  // Get article body text (paragraphs + list items), strip citation markers
  const text = $('div.mw-parser-output p, div.mw-parser-output li')
    .text()
    .replace(/\[\d+\]/g, '')
    .replace(/\s+/g, ' ');

  const result: Record<string, string> = {};
  for (const field of missing) {
    const patterns = PROSE_PATTERNS[field];
    if (!patterns) continue;
    for (const { re, fmt } of patterns) {
      const m = text.match(re);
      if (m) {
        result[field] = fmt(m).trim();
        break;
      }
    }
  }
  return result;
};

const parseHtmlFallback = (html: string, missing: string[]): Record<string, string> => {
  const $ = cheerio.load(html);
  const rows: Record<string, string> = {};
  $('table.infobox').each((_, tbl) => {
    $(tbl).find('tr').each((_, row) => {
      const th = $(row).find('th').first();
      const td = $(row).find('td').first();
      if (!th.length || !td.length) return;
      const label = th.text().replace(/\[.*?\]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
      const val = td.text().replace(/\[.*?\]/g, '').replace(/\s+/g, ' ').replace(/\s*\|\s*/g, ', ').trim();
      if (label && val && !rows[label]) rows[label] = val;
    });
  });

  const result: Record<string, string> = {};
  missing.forEach((field) => {
    const labels = HTML_LABEL_MAP[field] || [];
    for (const label of labels) {
      const v = rows[label.toLowerCase()];
      if (v) { result[field] = v; return; }
    }
  });
  return result;
};

// ─── Wikipedia API helpers ────────────────────────────────────────────────────

// Cache resolved page titles so repeat fetches skip all search+rank API calls
const pageTitleCache = new Map<string, string>();

/**
 * Find the best Wikipedia page for an aircraft name.
 * Uses hastemplate: search (same as suggest) — 2 parallel calls instead of 5.
 * Result is cached permanently for the session.
 */
const findAircraftPage = async (name: string): Promise<string> => {
  const key = name.toLowerCase();
  if (pageTitleCache.has(key)) return pageTitleCache.get(key)!;

  const enc = encodeURIComponent;
  const base = `https://en.wikipedia.org/w/api.php?action=query&list=search&srlimit=3&format=json&srnamespace=0&srprop=`;

  // Two parallel searches: aircraft infobox + weapon infobox
  const [r1, r2] = await Promise.allSettled([
    wikiGet(`${base}&srsearch=${enc(name + ' hastemplate:"Infobox aircraft"')}`),
    wikiGet(`${base}&srsearch=${enc(name + ' hastemplate:"Infobox weapon"')}`),
  ]);

  const candidates: string[] = [
    ...(r1.status === 'fulfilled' ? (r1.value.data.query?.search || []).map((h: any) => h.title) : []),
    ...(r2.status === 'fulfilled' ? (r2.value.data.query?.search || []).map((h: any) => h.title) : []),
  ].filter((t, i, a) => t && a.indexOf(t) === i);

  // Pick the first result whose title contains the query (most relevant)
  const qLower = name.toLowerCase();
  const best = candidates.find(t => t.toLowerCase().includes(qLower))
    || candidates[0]
    || name;

  pageTitleCache.set(key, best);
  return best;
};

// ── In-memory cache (TTL 30 min) to avoid re-hitting Wikipedia for the same page ──
const cache = new Map<string, { value: string; expires: number }>();
const CACHE_TTL = 30 * 60 * 1000;

const cachedGet = async (key: string, fetcher: () => Promise<string | null>): Promise<string | null> => {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.value;
  const value = await fetcher();
  if (value) cache.set(key, { value, expires: now + CACHE_TTL });
  return value;
};

const fetchWikitext = (title: string) =>
  cachedGet(`wt:${title}`, async () => {
    const url =
      `https://en.wikipedia.org/w/api.php?action=query` +
      `&titles=${encodeURIComponent(title)}` +
      `&prop=revisions&rvprop=content&rvslots=main&format=json&redirects=1`;
    const res = await wikiGet(url);
    const pages = res.data.query?.pages || {};
    const page: any = Object.values(pages)[0];
    return page?.revisions?.[0]?.slots?.main?.['*'] || page?.revisions?.[0]?.['*'] || null;
  });

const fetchHtml = (title: string) =>
  cachedGet(`html:${title}`, async () => {
    const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(title)}&prop=text&format=json&redirects=1`;
    const res = await wikiGet(url);
    return res.data.parse?.text?.['*'] || null;
  });



// ─── Aircraft name autocomplete ──────────────────────────────────────────────

// Aircraft-related title keywords — generic terms + manufacturer names + designation patterns only
// Deliberately excludes specific aircraft names that are also common words (Eagle, Falcon, etc.)

// ── Aircraft name index — loaded from disk only ───────────────────────────────
// Run `npx ts-node src/build-index.ts` once to generate aircraft-index.json
// Then the server reads it instantly on every startup — no Wikipedia calls.

let aircraftIndex: string[] = [];
const INDEX_FILE = path.join(__dirname, '../../aircraft-index.json');

try {
  aircraftIndex = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  console.log(`Aircraft index ready: ${aircraftIndex.length} titles`);
} catch {
  console.warn('aircraft-index.json not found. Run: npx ts-node src/build-index.ts');
}

// Strip all non-alphanumeric characters for fuzzy matching
// "f22" → "f22", "F-22 Raptor" → "f22raptor" → matches!
const stripped = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

app.get('/api/aircraft/suggest', (req: Request, res: Response) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);

  const qExact = q.toLowerCase();
  const qStripped = stripped(q);

  const results = aircraftIndex
    .filter(t => t.toLowerCase().includes(qExact) || stripped(t).includes(qStripped))
    .slice(0, 12);
  res.json(results);
});

// ─── Web search endpoint (DuckDuckGo HTML) ───────────────────────────────────

const SNIPPET_RE = /class="result__snippet"[^>]*>([\s\S]{5,600}?)<\/a/g;
const TITLE_RE   = /class="result__a"[^>]*>([\s\S]{3,150}?)<\/a/g;
const URL_RE     = /class="result__url"[^>]*>([\s\S]{3,200}?)<\/span/g;

const stripHtml = (s: string) =>
  s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/&amp;/g, '&')
   .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#\d+;/g, '').trim();

app.post('/api/aircraft/websearch', async (req: Request, res: Response) => {
  const { aircraftName, paramLabel } = req.body as { aircraftName: string; paramLabel: string };
  if (!aircraftName || !paramLabel)
    return res.status(400).json({ error: 'aircraftName and paramLabel required.' });

  const query = `${aircraftName} ${paramLabel}`;

  try {
    const response = await axios.post(
      'https://html.duckduckgo.com/html/',
      new URLSearchParams({ q: query }).toString(),
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'text/html',
        },
        timeout: 10000,
      }
    );

    const html: string = response.data;

    const snippets: string[] = [];
    const titles: string[] = [];
    const urls: string[] = [];

    let m: RegExpExecArray | null;
    SNIPPET_RE.lastIndex = 0; TITLE_RE.lastIndex = 0; URL_RE.lastIndex = 0;
    while ((m = SNIPPET_RE.exec(html)) !== null) snippets.push(stripHtml(m[1]));
    while ((m = TITLE_RE.exec(html)) !== null)   titles.push(stripHtml(m[1]));
    while ((m = URL_RE.exec(html)) !== null)      urls.push(stripHtml(m[1]));

    const results = snippets.slice(0, 4).map((snippet, i) => ({
      title:   titles[i]   || '',
      snippet,
      url:     urls[i]     || '',
    })).filter(r => r.snippet.length > 10);

    res.json({ query, results });
  } catch (err: any) {
    res.status(500).json({ error: 'Web search failed. Try again.' });
  }
});

// All mapped param keys — derived from the mapping dictionaries at runtime
// Used only to target HTML/prose/Wikidata fallbacks (we can't search for what we don't know about)
const ALL_KNOWN_PARAMS = Array.from(new Set([
  ...Object.values(UNIFIED_INFOBOX_KEY_MAP),
  ...Object.values(AIRCRAFT_SPECS_MAP).map(d => d.param),
]));

// ─── Fetch endpoint ───────────────────────────────────────────────────────────

app.post('/api/aircraft/fetch', async (req: Request, res: Response) => {
  const { names } = req.body as { names: string[] };
  if (!Array.isArray(names) || !names.length)
    return res.status(400).json({ error: 'names must be a non-empty array.' });

  const fetchOne = async (rawName: string) => {
    const name = String(rawName).trim();
    try {
      // ── 1. Find the right Wikipedia page ──────────────────────────────
      const pageTitle = await findAircraftPage(name);

      // ── 2. Fetch & parse wikitext (primary source, cached after first fetch) ──
      const wikitext = await fetchWikitext(pageTitle);
      let merged: Record<string, string> = {};
      if (wikitext) {
        const specsParams = mapAircraftSpecs(wikitext);
        const infoboxParams = extractAllInfoboxes(wikitext);
        merged = { ...infoboxParams, ...specsParams };
      }

      // ── 3. HTML fallback — only if wikitext gave very few params ──────────
      // Most well-documented aircraft have 20+ params from wikitext alone.
      // HTML fetch is ~1.4s and rarely adds significant new data.
      if (Object.keys(merged).length < 5) {
        const html = await fetchHtml(pageTitle);
        if (html) {
          const afterWiki = ALL_KNOWN_PARAMS.filter(f => !merged[f]);
          const htmlParams = parseHtmlFallback(html, afterWiki);
          merged = { ...htmlParams, ...merged };
          const afterInbox = ALL_KNOWN_PARAMS.filter(f => !merged[f]);
          if (afterInbox.length > 0) {
            const proseParams = extractFromProse(html, afterInbox);
            merged = { ...proseParams, ...merged };
          }
        }
      }

      const params: Record<string, string> = Object.fromEntries(
        Object.entries(merged).filter(([, v]) => v && v.trim())
      );

      return {
        name,
        params,
        source: `https://en.wikipedia.org/wiki/${encodeURIComponent(pageTitle.replace(/ /g, '_'))}`,
      };
    } catch (err: any) {
      return { name, params: {}, error: err?.message || 'Failed to fetch data.' };
    }
  };

  // Fetch all aircraft in parallel — retry handles any 429s
  const items = await Promise.all(names.map(fetchOne));

  res.json(items);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
