import { useState, useEffect, useRef } from 'react';
import axios from 'axios';

// In dev: Vite proxies /api → localhost:4000
// In production (Vercel): /api routes are serverless functions on same domain
const API = '';

// Auto-generate a readable label from a camelCase key
const keyToLabel = (key: string): string =>
  key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, s => s.toUpperCase())
    .trim();

// Optional nicer overrides for known keys
const LABEL_OVERRIDES: Record<string, string> = {
  role: 'Role / Type', countryOfOrigin: 'Country of Origin',
  designation: 'Designation / Model', primaryUser: 'Primary User / Operator',
  numberBuilt: 'Number Built', firstFlight: 'First Flight',
  serviceEntry: 'Service Entry', wingArea: 'Wing Area',
  fuselageWidth: 'Fuselage Width / Diameter', aspectRatio: 'Aspect Ratio',
  rotorDiameter: 'Rotor Diameter', cabinLength: 'Cabin Length',
  cabinWidth: 'Cabin Width', cabinHeight: 'Cabin Height',
  emptyWeight: 'Empty Weight', grossWeight: 'Gross Weight',
  maxTakeoffWeight: 'Max Takeoff Weight (MTOW)', fuelCapacity: 'Fuel Capacity',
  maxPayload: 'Max Payload', maxSpeed: 'Max Speed', cruiseSpeed: 'Cruise Speed',
  stallSpeed: 'Stall Speed', ferryRange: 'Ferry Range',
  combatRange: 'Combat Range / Radius', serviceCeiling: 'Service Ceiling',
  rateOfClimb: 'Rate of Climb', wingLoading: 'Wing Loading',
  thrustToWeight: 'Thrust-to-Weight Ratio', gLimits: 'G Limits',
  takeoffRun: 'Takeoff Run', landingRun: 'Landing Run', machNumber: 'Mach Number',
  engineType: 'Engine Type / Powerplant', numberOfEngines: 'Number of Engines',
  thrustWithAfterburner: 'Thrust with Afterburner', powerOutput: 'Power Output',
  guns: 'Guns / Cannon', icaoCode: 'ICAO Code', iataCode: 'IATA Code',
  flyByWire: 'Fly-by-Wire', passengerCapacity: 'Passenger Capacity',
  cargoCapacity: 'Cargo Capacity',
};

const getLabel = (key: string) => LABEL_OVERRIDES[key] || keyToLabel(key);

// Category groupings — keys not in any group go to "Other"
const CATEGORY_KEYS: { group: string; keys: string[] }[] = [
  { group: 'Identity',          keys: ['role','manufacturer','designer','countryOfOrigin','designation','variants'] },
  { group: 'History',           keys: ['firstFlight','serviceEntry','retired','status','numberBuilt','primaryUser'] },
  { group: 'Dimensions',        keys: ['length','wingspan','wingArea','height','fuselageWidth','aspectRatio','cabinLength','cabinWidth','cabinHeight','rotorDiameter'] },
  { group: 'Weight',            keys: ['emptyWeight','grossWeight','maxTakeoffWeight','fuelCapacity','maxPayload'] },
  { group: 'Performance',       keys: ['maxSpeed','cruiseSpeed','stallSpeed','range','ferryRange','combatRange','serviceCeiling','rateOfClimb','wingLoading','thrustToWeight','gLimits','endurance','takeoffRun','landingRun','machNumber'] },
  { group: 'Powerplant',        keys: ['engineType','numberOfEngines','thrust','thrustWithAfterburner','powerOutput','propeller'] },
  { group: 'Military',          keys: ['crew','armament','hardpoints','guns','missiles','bombs','radar','avionics','operators'] },
  { group: 'Civil / Commercial',keys: ['passengerCapacity','cargoCapacity','icaoCode','iataCode','certification','flyByWire'] },
];

const ALL_CATEGORIZED = new Set(CATEGORY_KEYS.flatMap(c => c.keys));

// Group params into categories + catch-all "Other" for anything unexpected
const groupParams = (params: Record<string, string>) => {
  const result: { group: string; entries: [string, string][] }[] = [];

  for (const cat of CATEGORY_KEYS) {
    const entries: [string, string][] = cat.keys
      .filter(k => params[k])
      .map(k => [k, params[k]]);
    if (entries.length) result.push({ group: cat.group, entries });
  }

  // Any key not in a known category goes to "Other"
  const other: [string, string][] = Object.entries(params)
    .filter(([k]) => !ALL_CATEGORIZED.has(k));
  if (other.length) result.push({ group: 'Other', entries: other });

  return result;
};

type AircraftRecord = {
  name: string;
  status: 'idle' | 'fetching' | 'done' | 'error';
  params: Record<string, string>;
  source?: string;
  error?: string;
};

function App() {
  const [nameInput, setNameInput]       = useState('');
  const [suggestions, setSuggestions]   = useState<string[]>([]);
  const [showDrop, setShowDrop]         = useState(false);
  const [loadingSug, setLoadingSug]     = useState(false);
  const [aircraftList, setAircraftList] = useState<string[]>([]);
  const [aircraftData, setAircraftData] = useState<Record<string, AircraftRecord>>({});
  const [selectedAircraft, setSelectedAircraft] = useState<string | null>(null);
  const [busy, setBusy]                 = useState(false);
  const [message, setMessage]           = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapperRef  = useRef<HTMLDivElement>(null);

  // Fetch suggestions as user types (debounced 500ms)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (nameInput.trim().length < 2) {
      setSuggestions([]);
      setShowDrop(false);
      setLoadingSug(false);
      return;
    }

    // Show loading immediately so dropdown is visible right away
    setLoadingSug(true);
    setShowDrop(true);

    debounceRef.current = setTimeout(async () => {
      try {
        const { data } = await axios.get(`${API}/api/aircraft/suggest?q=${encodeURIComponent(nameInput.trim())}`);
        setSuggestions(data);
        setShowDrop(true);
      } catch {
        setSuggestions([]);
      } finally {
        setLoadingSug(false);
      }
    }, 350);
  }, [nameInput]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node))
        setShowDrop(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const selectedRecord = selectedAircraft ? aircraftData[selectedAircraft] : null;

  const addAircraft = (name: string) => {
    const t = name.trim();
    if (!t) return;
    setAircraftList(prev => Array.from(new Set([...prev, t])));
    setAircraftData(prev => ({ ...prev, [t]: prev[t] ?? { name: t, status: 'idle', params: {} } }));
    setNameInput('');
  };

  const removeAircraft = (name: string) => {
    setAircraftList(prev => prev.filter(n => n !== name));
    setAircraftData(prev => { const next = { ...prev }; delete next[name]; return next; });
    if (selectedAircraft === name) setSelectedAircraft(null);
  };


  const fetchAircraft = async () => {
    const active = aircraftList.filter(Boolean);
    if (!active.length) { setMessage('Add at least one aircraft name.'); return; }
    setMessage(null);
    setBusy(true);
    setAircraftData(prev => {
      const next = { ...prev };
      active.forEach(n => { next[n] = { ...next[n], status: 'fetching', error: undefined }; });
      return next;
    });
    try {
      const { data } = await axios.post(`${API}/api/aircraft/fetch`, { names: active });
      const updated: Record<string, AircraftRecord> = {};
      data.forEach((item: any) => {
        updated[item.name] = {
          name: item.name,
          status: item.error ? 'error' : 'done',
          params: item.params ?? {},
          source: item.source,
          error: item.error,
        };
      });
      setAircraftData(prev => ({ ...prev, ...updated }));
      setMessage('Done. Click an aircraft to view its data.');
    } catch {
      setMessage('Server error. Make sure the backend is running.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app-shell">
      <header>
        <h1>Aircraft Data Collector</h1>
        <p>Add aircraft names and fetch all available data from Wikipedia automatically.</p>
      </header>

      <section className="input-card">
        <label>Add aircraft name</label>
        <div className="input-row" ref={wrapperRef} style={{ position: 'relative' }}>
          <div style={{ flex: 1, position: 'relative' }}>
            <input
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              placeholder="e.g. F-22 Raptor, Boeing 747, Shahed 136, Bayraktar TB2"
              onKeyDown={e => { if (e.key === 'Enter') { addAircraft(nameInput); setShowDrop(false); } if (e.key === 'Escape') setShowDrop(false); }}
              onFocus={() => suggestions.length > 0 && setShowDrop(true)}
              autoComplete="off"
              style={{ width: '100%' }}
            />
            {showDrop && (
              <ul className="suggest-dropdown">
                {loadingSug && <li className="suggest-loading">Searching Wikipedia...</li>}
                {suggestions.map(s => {
                  const already = aircraftList.includes(s);
                  return (
                    <li
                      key={s}
                      className={already ? 'suggest-added' : ''}
                      onMouseDown={() => { addAircraft(s); /* keep dropdown open for multi-select */ }}
                    >
                      <span className="suggest-check">{already ? '✓' : ''}</span>
                      {s}
                    </li>
                  );
                })}
                {!loadingSug && suggestions.length > 0 && (
                  <li className="suggest-footer" onMouseDown={() => setShowDrop(false)}>
                    Close
                  </li>
                )}
              </ul>
            )}
          </div>
          <button disabled={!nameInput.trim()} onClick={() => { addAircraft(nameInput); setShowDrop(false); }}>Add</button>
        </div>
      </section>

      <section className="action-row">
        <button className="fetch-button" disabled={busy || !aircraftList.length} onClick={fetchAircraft}>
          {busy ? 'Fetching...' : `Fetch Data for ${aircraftList.length} Aircraft`}
        </button>
        {message && <div className="message">{message}</div>}
      </section>

      <main className="workspace">
        <aside className="aircraft-list">
          <h2>Aircraft ({aircraftList.length})</h2>
          {!aircraftList.length ? (
            <p className="empty-hint">No aircraft added yet.</p>
          ) : (
            <ul>
              {aircraftList.map(name => {
                const rec = aircraftData[name];
                const count = Object.keys(rec?.params ?? {}).length;
                return (
                  <li key={name} onClick={() => setSelectedAircraft(name)} className={selectedAircraft === name ? 'selected' : ''}>
                    <div className="aircraft-info">
                      <span className="aircraft-name">{name}</span>
                      {rec?.status === 'done' && <span className="param-count">{count} params found</span>}
                    </div>
                    <div className="list-right">
                      <span className={`status ${rec?.status ?? 'idle'}`}>{rec?.status ?? 'idle'}</span>
                      <button className="remove-btn" onClick={e => { e.stopPropagation(); removeAircraft(name); }}>×</button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <section className="details-panel">
          {!selectedRecord ? (
            <><h2>Parameters</h2><p className="empty-hint">Select an aircraft to view its data.</p></>
          ) : selectedRecord.error ? (
            <><h2>{selectedRecord.name}</h2><div className="error-card">{selectedRecord.error}</div></>
          ) : selectedRecord.status === 'fetching' ? (
            <><h2>{selectedRecord.name}</h2><p className="empty-hint">Fetching data from Wikipedia...</p></>
          ) : selectedRecord.status === 'idle' ? (
            <><h2>{selectedRecord.name}</h2><p className="empty-hint">Click "Fetch Data" to load parameters.</p></>
          ) : !Object.keys(selectedRecord.params).length ? (
            <><h2>{selectedRecord.name}</h2><p className="empty-hint">No data found on Wikipedia for this aircraft.</p></>
          ) : (
            <>
              <div className="details-header">
                <h2>{selectedRecord.name}</h2>
                {selectedRecord.source && (
                  <a className="source-link" href={selectedRecord.source} target="_blank" rel="noreferrer">Wikipedia ↗</a>
                )}
              </div>
              <div className="categories-container">
                {groupParams(selectedRecord.params).map(({ group, entries }) => (
                  <div key={group} className="category-section">
                    <h3 className="category-title">{group}</h3>
                    <div className="params-grid">
                      {entries.map(([key, value]) => (
                        <div key={key} className="param-card">
                          <div className="param-label">{getLabel(key)}</div>
                          <pre>{value}</pre>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}

export default App;
