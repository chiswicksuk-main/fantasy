'use strict';

// ---------- Rules ----------

const BUDGET = 100;
const SQUAD_SIZE = 15;
const SQUAD_SLOTS = { GK: 2, DEF: 5, MID: 5, FWD: 3 };
const MAX_PER_CLUB = 3;
const XI_LIMITS = { GK: [1, 1], DEF: [3, 5], MID: [2, 5], FWD: [1, 3] };
const MAX_MANAGERS = 8;
const TRANSFER_HIT = 4;
const POSITIONS = ['GK', 'DEF', 'MID', 'FWD'];
const STORE_KEY = 'j1-fantasy.v1';

const SCORING = {
  played: 1,        // 1-59 minutes
  played60: 2,      // 60+ minutes
  goal: { GK: 6, DEF: 6, MID: 5, FWD: 4 },
  assist: 3,
  cleanSheet: { GK: 4, DEF: 4, MID: 1, FWD: 0 }, // needs 60+ minutes
  savesPerPoint: 3, // GK only
  yellow: -1,
  red: -3,
  ownGoal: -2,
  penMissed: -2,
  penSaved: 5,
};

// Stats CSV columns, with the header spellings we accept for each.
const STAT_COLUMNS = {
  id: ['playerid', 'id', 'player'],
  minutes: ['minutes', 'mins', 'min'],
  goals: ['goals', 'goal', 'g'],
  assists: ['assists', 'assist', 'a'],
  cleanSheet: ['cleansheet', 'cleansheets', 'cs'],
  saves: ['saves', 'save'],
  yellow: ['yellow', 'yellows', 'yellowcard', 'yellowcards', 'yc'],
  red: ['red', 'reds', 'redcard', 'redcards', 'rc'],
  ownGoal: ['owngoal', 'owngoals', 'og'],
  pensMissed: ['pensmissed', 'penmissed', 'penaltiesmissed', 'penaltymissed'],
  pensSaved: ['penssaved', 'pensaved', 'penaltiessaved', 'penaltysaved'],
};
const STAT_HEADER = 'playerId,minutes,goals,assists,cleanSheet,saves,yellow,red,ownGoal,pensMissed,pensSaved';

// ---------- Data (read-only, from data/*.json) ----------

const DATA = { players: [], clubs: [], byId: new Map(), clubById: new Map(), fixtures: { gameweeks: [] } };

async function loadData() {
  const [players, fixtures] = await Promise.all([
    fetch('data/players.json', { cache: 'no-cache' }).then(r => r.json()),
    fetch('data/fixtures.json', { cache: 'no-cache' }).then(r => r.json()),
  ]);
  DATA.players = players.players;
  DATA.clubs = players.clubs;
  DATA.fixtures = fixtures;
  for (const p of DATA.players) DATA.byId.set(p.id, p);
  for (const c of DATA.clubs) DATA.clubById.set(c.id, c);
}

const player = id => DATA.byId.get(id);

function fixtureText(clubId, gw) {
  const round = DATA.fixtures.gameweeks.find(g => g.gw === gw);
  const m = round && round.matches.find(x => x.home === clubId || x.away === clubId);
  if (!m) return '';
  return m.home === clubId ? `v ${m.away} (H)` : `v ${m.home} (A)`;
}

// ---------- Saved state (localStorage) ----------

let state;

function newState() {
  return { version: 1, currentGw: DATA.fixtures.currentGameweek || 1, activeId: null, managers: [], results: {} };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return dropUnknownPlayers(JSON.parse(raw));
  } catch (e) { /* storage blocked or corrupt: start fresh */ }
  return newState();
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { toast('Could not save – storage is full or blocked'); }
}

// If players.json is rebuilt and an id disappears, take it out of squads.
function dropUnknownPlayers(s) {
  for (const m of s.managers) {
    m.squad = m.squad.filter(id => DATA.byId.has(id));
    m.picks.starters = m.picks.starters.filter(id => DATA.byId.has(id));
    m.picks.bench = m.picks.bench.filter(id => DATA.byId.has(id));
  }
  return s;
}

const activeManager = () => state.managers.find(m => m.id === state.activeId) || null;
const isLocked = () => Boolean(state.results[state.currentGw]);

function newManager(name) {
  return {
    id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name,
    squad: [],
    confirmed: false,       // first full squad saved; from then on changes are transfers
    gwStartSquad: null,     // squad at the start of the current gameweek
    picks: { starters: [], bench: [], captain: null },
    history: {},            // gw -> frozen picks used for scoring
  };
}

// ---------- Squad ----------

const round1 = n => Math.round(n * 10) / 10;
const squadCost = m => round1(m.squad.reduce((sum, id) => sum + player(id).price, 0));
const bank = m => round1(BUDGET - squadCost(m));
const countBy = (ids, key) => ids.reduce((acc, id) => {
  const k = player(id)[key];
  acc[k] = (acc[k] || 0) + 1;
  return acc;
}, {});

function transfersMade(m) {
  if (!m.confirmed || !m.gwStartSquad) return 0;
  return m.squad.filter(id => !m.gwStartSquad.includes(id)).length;
}
const transferHit = m => Math.max(0, transfersMade(m) - 1) * TRANSFER_HIT;

// Returns why a player can't be added, or '' if they can.
function addBlocker(m, p) {
  if (m.squad.includes(p.id)) return 'In squad';
  if (m.squad.length >= SQUAD_SIZE) return 'Squad full';
  if ((countBy(m.squad, 'position')[p.position] || 0) >= SQUAD_SLOTS[p.position]) return `${p.position} full`;
  if ((countBy(m.squad, 'club')[p.club] || 0) >= MAX_PER_CLUB) return `3 from ${p.club}`;
  if (p.price > bank(m) + 1e-9) return 'Too expensive';
  return '';
}

function addPlayer(m, id) {
  const why = addBlocker(m, player(id));
  if (why) return toast(why);
  m.squad.push(id);
  fitNewPlayersIntoPicks(m);
  if (m.confirmed && transfersMade(m) > 1) toast(`Extra transfer: −${TRANSFER_HIT} pts`);
  save();
}

function removePlayer(m, id) {
  m.squad = m.squad.filter(x => x !== id);
  m.picks.starters = m.picks.starters.filter(x => x !== id);
  m.picks.bench = m.picks.bench.filter(x => x !== id);
  if (m.picks.captain === id) m.picks.captain = null;
  save();
}

function confirmSquad(m) {
  if (m.squad.length !== SQUAD_SIZE) return;
  m.confirmed = true;
  m.gwStartSquad = [...m.squad];
  autoPick(m);
  save();
  toast('Squad saved. One free transfer per gameweek from now on.');
}

// ---------- Lineup ----------

function xiProblems(starters) {
  const problems = [];
  if (starters.length !== 11) problems.push(`Pick 11 starters (now ${starters.length})`);
  const c = countBy(starters, 'position');
  for (const pos of POSITIONS) {
    const [min, max] = XI_LIMITS[pos];
    const n = c[pos] || 0;
    if (n < min || n > max) problems.push(`${pos}: ${min === max ? min : `${min}–${max}`} needed (now ${n})`);
  }
  return problems;
}

const formation = starters => {
  const c = countBy(starters, 'position');
  return `${c.DEF || 0}-${c.MID || 0}-${c.FWD || 0}`;
};

// Default XI: best-priced GK, then the minimum per position, then the best of the rest.
function autoPick(m) {
  const byPrice = [...m.squad].sort((a, b) => player(b).price - player(a).price);
  const starters = [];
  const c = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  const take = id => { starters.push(id); c[player(id).position]++; };
  for (const pos of POSITIONS) {
    byPrice.filter(id => player(id).position === pos).slice(0, XI_LIMITS[pos][0]).forEach(take);
  }
  for (const id of byPrice) {
    if (starters.length === 11) break;
    const pos = player(id).position;
    if (!starters.includes(id) && c[pos] < XI_LIMITS[pos][1]) take(id);
  }
  const bench = byPrice.filter(id => !starters.includes(id))
    .sort((a, b) => (player(a).position === 'GK' ? -1 : 0) - (player(b).position === 'GK' ? -1 : 0));
  m.picks = { starters, bench, captain: defaultCaptain(starters) };
}

// Most expensive outfield starter.
const defaultCaptain = starters => [...starters]
  .sort((a, b) => player(b).price - player(a).price)
  .find(id => player(id).position !== 'GK') || starters[0] || null;

// After a transfer: newcomers take a free starting spot if the formation allows, otherwise the bench.
function fitNewPlayersIntoPicks(m) {
  if (!m.confirmed) return;
  const placed = new Set([...m.picks.starters, ...m.picks.bench]);
  for (const id of m.squad) {
    if (placed.has(id)) continue;
    const pos = player(id).position;
    const c = countBy(m.picks.starters, 'position');
    if (m.picks.starters.length < 11 && (c[pos] || 0) < XI_LIMITS[pos][1]) m.picks.starters.push(id);
    else m.picks.bench.push(id);
  }
  if (!m.picks.captain) m.picks.captain = defaultCaptain(m.picks.starters);
}

function swap(m, a, b) {
  const { starters, bench } = m.picks;
  const aStarts = starters.includes(a), bStarts = starters.includes(b);
  if (aStarts && bStarts) return toast('Pick a bench player to swap with');
  if (!aStarts && !bStarts) {
    const i = bench.indexOf(a), j = bench.indexOf(b);
    [bench[i], bench[j]] = [bench[j], bench[i]];
    return save();
  }
  const out = aStarts ? a : b, inn = aStarts ? b : a;
  const next = starters.map(id => (id === out ? inn : id));
  if (starters.length === 11 && xiProblems(next).length) return toast(`Not allowed: ${xiProblems(next)[0]}`);
  m.picks.starters = next;
  m.picks.bench = bench.map(id => (id === inn ? out : id));
  if (m.picks.captain === out) {
    m.picks.captain = inn;
    toast(`Captaincy moved to ${player(inn).name}`);
  }
  save();
}

function moveBench(m, id, dir) {
  const b = m.picks.bench, i = b.indexOf(id), j = i + dir;
  if (j < 0 || j >= b.length) return;
  [b[i], b[j]] = [b[j], b[i]];
  save();
}

const snapshot = m => ({
  squad: [...m.squad],
  starters: [...m.picks.starters],
  bench: [...m.picks.bench],
  captain: m.picks.captain,
  transfers: transfersMade(m),
  hit: transferHit(m),
});

// ---------- Scoring ----------

function playerPoints(p, s) {
  const parts = [];
  if (!s || !(s.minutes > 0)) return { total: 0, parts, played: false };
  const add = (label, pts) => { if (pts) parts.push([label, pts]); };
  add(s.minutes >= 60 ? '60+ mins' : `${s.minutes} mins`, s.minutes >= 60 ? SCORING.played60 : SCORING.played);
  add(`Goal ×${s.goals}`, s.goals * SCORING.goal[p.position]);
  add(`Assist ×${s.assists}`, s.assists * SCORING.assist);
  if (s.cleanSheet && s.minutes >= 60) add('Clean sheet', SCORING.cleanSheet[p.position]);
  if (p.position === 'GK') add(`${s.saves} saves`, Math.floor(s.saves / SCORING.savesPerPoint));
  add('Yellow', s.yellow * SCORING.yellow);
  add('Red', s.red * SCORING.red);
  add(`Own goal ×${s.ownGoal}`, s.ownGoal * SCORING.ownGoal);
  add(`Pen missed ×${s.pensMissed}`, s.pensMissed * SCORING.penMissed);
  add(`Pen saved ×${s.pensSaved}`, s.pensSaved * SCORING.penSaved);
  return { total: parts.reduce((t, [, v]) => t + v, 0), parts, played: true };
}

const minutesIn = (stats, id) => (stats[id] ? stats[id].minutes : 0);

// Bench players come on in bench order for starters with 0 minutes,
// as long as the formation stays legal (a GK can only replace a GK).
function autoSubs(picks, stats) {
  const xi = [...picks.starters];
  const used = new Set();
  const subs = [];
  xi.forEach((id, i) => {
    if (minutesIn(stats, id) > 0) return;
    for (const b of picks.bench) {
      if (used.has(b) || minutesIn(stats, b) === 0) continue;
      const goalkeeperSwap = player(id).position === 'GK';
      if (goalkeeperSwap !== (player(b).position === 'GK')) continue;
      const trial = xi.map((x, k) => (k === i ? b : x));
      if (!goalkeeperSwap && xiProblems(trial).length && !xiProblems(xi).length) continue;
      xi[i] = b;
      used.add(b);
      subs.push({ out: id, in: b });
      break;
    }
  });
  return { xi, subs, unused: picks.bench.filter(b => !used.has(b)) };
}

function picksForGw(m, gw) {
  if (m.history[gw]) return m.history[gw];
  if (gw === state.currentGw && m.confirmed) return snapshot(m);
  return null;
}

function scoreGw(m, gw) {
  const result = state.results[gw];
  const picks = picksForGw(m, gw);
  if (!result || !picks) return null;
  const { xi, subs, unused } = autoSubs(picks, result.stats);
  const captainPlays = xi.includes(picks.captain) && minutesIn(result.stats, picks.captain) > 0;
  const line = (id, counts) => {
    const pts = playerPoints(player(id), result.stats[id]);
    const mult = counts && captainPlays && id === picks.captain ? 2 : 1;
    return { id, ...pts, mult, points: counts ? pts.total * mult : 0 };
  };
  const lines = xi.map(id => line(id, true));
  const bench = unused.map(id => line(id, false));
  const gross = lines.reduce((t, l) => t + l.points, 0);
  return { lines, bench, subs, captain: picks.captain, captainPlays, hit: picks.hit || 0, gross, total: gross - (picks.hit || 0) };
}

const scoredGws = () => Object.keys(state.results).map(Number).sort((a, b) => a - b);
const totalPoints = m => scoredGws().reduce((t, gw) => t + (scoreGw(m, gw)?.total || 0), 0);

// ---------- Stats import ----------

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === '\t') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => v.trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(v => v.trim())) rows.push(row);
  return rows.map(r => r.map(v => v.trim()));
}

function parseStats(text) {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (!rows.length) throw new Error('No rows found');
  const header = rows.shift().map(h => h.toLowerCase().replace(/[^a-z]/g, ''));
  const col = {};
  for (const [key, names] of Object.entries(STAT_COLUMNS)) {
    col[key] = header.findIndex(h => names.includes(h));
  }
  if (col.id < 0 || col.minutes < 0) throw new Error('Header needs at least playerId and minutes');
  const num = (r, key) => {
    if (col[key] < 0) return 0;
    const v = (r[col[key]] || '').toLowerCase();
    if (['true', 'yes', 'y'].includes(v)) return 1;
    return Math.max(0, parseInt(v, 10) || 0);
  };
  const stats = {}, unknown = [];
  for (const r of rows) {
    const id = r[col.id];
    if (!id) continue;
    if (!DATA.byId.has(id)) { unknown.push(id); continue; }
    stats[id] = Object.fromEntries(Object.keys(STAT_COLUMNS).filter(k => k !== 'id').map(k => [k, num(r, k)]));
  }
  return { stats, unknown };
}

function importStats(gw, text) {
  if (gw > state.currentGw) return toast(`GW ${gw} hasn't started – advance the gameweek first`);
  let parsed;
  try { parsed = parseStats(text); } catch (e) { return toast(e.message); }
  const n = Object.keys(parsed.stats).length;
  if (!n) return toast('No known player ids in that file');
  if (gw === state.currentGw) {
    for (const m of state.managers) if (m.confirmed && !m.history[gw]) m.history[gw] = snapshot(m);
  }
  state.results[gw] = { stats: parsed.stats, unknownIds: parsed.unknown, importedAt: new Date().toISOString() };
  ui.resultsGw = gw;
  save();
  render();
  toast(`GW ${gw}: ${n} players imported` + (parsed.unknown.length ? `, ${parsed.unknown.length} unknown ids skipped` : ''));
}

function statsTemplate() {
  const rows = DATA.players.map(p => `${p.id},0,0,0,0,0,0,0,0,0,0,"${p.name}",${p.club},${p.position}`);
  return `${STAT_HEADER},name,club,position\n${rows.join('\n')}\n`;
}

function advanceGw() {
  for (const m of state.managers) {
    if (m.confirmed && !m.history[state.currentGw]) m.history[state.currentGw] = snapshot(m);
    if (m.confirmed) m.gwStartSquad = [...m.squad];
  }
  state.currentGw++;
  ui.selected = null;
  save();
  render();
  toast(`Now on gameweek ${state.currentGw}`);
}

// ---------- League file export / import ----------

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function importLeague(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { return toast('Not a league file'); }
  if (!data || !Array.isArray(data.managers)) return toast('Not a league file');
  const incoming = dropUnknownPlayers(data);
  for (const m of incoming.managers) {
    const i = state.managers.findIndex(x => x.id === m.id);
    if (i >= 0) state.managers[i] = m;
    else if (state.managers.length < MAX_MANAGERS) state.managers.push(m);
    else toast(`League full – skipped ${m.name}`);
  }
  Object.assign(state.results, incoming.results || {});
  state.currentGw = Math.max(state.currentGw, incoming.currentGw || 1);
  if (!activeManager()) state.activeId = state.managers[0]?.id || null;
  save();
  render();
  toast(`Imported ${incoming.managers.length} manager(s)`);
}

// ---------- Rendering ----------

const ui = { tab: 'squad', search: '', club: '', pos: '', sort: 'price', selected: null, resultsGw: null };
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => n.toFixed(1);
const signed = n => (n > 0 ? `+${n}` : String(n));
const shortName = p => {
  const parts = p.name.split(' ');
  return parts.length > 1 && !/^(Kim|Lee|Park|Cha|Oh|Eom|Yun|Na|Ko|Zhang)$/.test(parts[0]) ? parts.slice(1).join(' ') : p.name;
};

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

function render() {
  const m = activeManager();
  $('#manager-select').innerHTML = state.managers.length
    ? state.managers.map(x => `<option value="${x.id}" ${x.id === state.activeId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')
    : '<option>No managers</option>';
  $('#gw-chip').textContent = `GW ${state.currentGw}` + (isLocked() ? ' ✓' : '');
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === ui.tab));

  const view = $('#view');
  if (!m && ui.tab !== 'league') { view.innerHTML = welcomeView(); return; }
  view.innerHTML = { squad: squadView, lineup: lineupView, results: resultsView, league: leagueView }[ui.tab](m);
  if (ui.tab === 'squad') renderPlayerList(m);
}

function welcomeView() {
  return `<section class="card">
    <h2>Welcome</h2>
    <p>Pick a 15-player squad of real J1 players for 100m, set a lineup each gameweek and score points from real stats.</p>
    <form data-form="add-manager" class="row">
      <input name="name" placeholder="Manager name" maxlength="24" required>
      <button class="primary">Start</button>
    </form>
    <p class="muted small">Up to ${MAX_MANAGERS} managers can share this device. Everything is saved in this browser.</p>
  </section>`;
}

function lockNote() {
  return isLocked()
    ? `<div class="note">GW ${state.currentGw} results are in, so changes are locked. Go to Results → “Start GW ${state.currentGw + 1}”.</div>`
    : '';
}

function squadView(m) {
  const pos = countBy(m.squad, 'position');
  const b = bank(m);
  const t = transfersMade(m);
  const slots = POSITIONS.map(p => `<span class="slot ${(pos[p] || 0) === SQUAD_SLOTS[p] ? 'full' : ''}">${p} ${pos[p] || 0}/${SQUAD_SLOTS[p]}</span>`).join('');
  const groups = POSITIONS.map(p => {
    const ids = m.squad.filter(id => player(id).position === p);
    return `<div class="sq-group"><div class="sq-label">${p}</div>${ids.map(id => {
      const pl = player(id);
      return `<span class="sq-chip">${esc(shortName(pl))} <small>${pl.club} ${money(pl.price)}</small>
        ${isLocked() ? '' : `<button class="x" data-action="remove" data-id="${pl.id}" aria-label="Remove ${esc(pl.name)}">×</button>`}</span>`;
    }).join('') || '<span class="muted small">empty</span>'}</div>`;
  }).join('');

  return `${lockNote()}
  <section class="card budget">
    <div class="stats3">
      <div><span class="label">Bank</span><strong class="${b < 0 ? 'neg' : ''}">${money(b)}m</strong></div>
      <div><span class="label">Squad</span><strong>${m.squad.length}/${SQUAD_SIZE}</strong></div>
      <div><span class="label">Transfers</span><strong>${m.confirmed ? `${t}${transferHit(m) ? ` <span class="neg">−${transferHit(m)}</span>` : ' free'}` : 'unlimited'}</strong></div>
    </div>
    <div class="meter"><div style="width:${Math.min(100, (squadCost(m) / BUDGET) * 100)}%"></div></div>
    <div class="slots">${slots}</div>
    ${!m.confirmed && m.squad.length === SQUAD_SIZE ? '<button class="primary wide" data-action="confirm">Save squad</button>' : ''}
    ${!m.confirmed && m.squad.length < SQUAD_SIZE ? '<p class="muted small">Changes are free until you save your first full squad. After that: 1 free transfer per gameweek, then −4 each.</p>' : ''}
  </section>
  <section class="card">
    <h2>My squad</h2>
    ${groups}
  </section>
  <section class="card">
    <h2>Players</h2>
    <div class="filters">
      <input type="search" id="f-search" placeholder="Search name / 名前" value="${esc(ui.search)}">
      <div class="row">
        <select id="f-club"><option value="">All clubs</option>${DATA.clubs.map(c => `<option value="${c.id}" ${ui.club === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
        <select id="f-sort">
          <option value="price" ${ui.sort === 'price' ? 'selected' : ''}>Price ↓</option>
          <option value="cheap" ${ui.sort === 'cheap' ? 'selected' : ''}>Price ↑</option>
          <option value="name" ${ui.sort === 'name' ? 'selected' : ''}>Name</option>
        </select>
      </div>
      <div class="pos-filter">${['', ...POSITIONS].map(p => `<button data-action="pos" data-pos="${p}" class="${ui.pos === p ? 'on' : ''}">${p || 'All'}</button>`).join('')}</div>
    </div>
    <div id="player-list"></div>
  </section>`;
}

function renderPlayerList(m) {
  const q = ui.search.trim().toLowerCase();
  let list = DATA.players.filter(p =>
    (!ui.club || p.club === ui.club) &&
    (!ui.pos || p.position === ui.pos) &&
    (!q || p.name.toLowerCase().includes(q) || p.nameJa.includes(q)));
  const sorters = {
    price: (a, b) => b.price - a.price || a.name.localeCompare(b.name),
    cheap: (a, b) => a.price - b.price || a.name.localeCompare(b.name),
    name: (a, b) => a.name.localeCompare(b.name),
  };
  list.sort(sorters[ui.sort]);
  const total = list.length;
  list = list.slice(0, 120);
  const locked = isLocked();
  $('#player-list').innerHTML = list.map(p => {
    const inSquad = m.squad.includes(p.id);
    const why = inSquad ? '' : addBlocker(m, p);
    const fx = fixtureText(p.club, state.currentGw);
    return `<div class="prow ${inSquad ? 'mine' : ''}">
      <span class="pos pos-${p.position}">${p.position}</span>
      <div class="pinfo">
        <div class="pname">${esc(p.name)}${p.verified ? '' : ' <span class="unv" title="Not confirmed against official sources">unverified</span>'}${statusBadge(p)}</div>
        <div class="psub">${esc(p.nameJa)} · ${p.club}${fx ? ` · ${fx}` : ''}</div>
      </div>
      <div class="price">${money(p.price)}</div>
      ${locked ? '' : inSquad
        ? `<button class="btn-rm" data-action="remove" data-id="${p.id}" aria-label="Remove">−</button>`
        : `<button class="btn-add ${why ? 'blocked' : ''}" data-action="add" data-id="${p.id}" title="${esc(why || 'Add')}" aria-label="Add">+</button>`}
    </div>`;
  }).join('') + (total > list.length ? `<p class="muted small center">Showing ${list.length} of ${total}. Search or filter to see more.</p>` : '')
    + (total ? '' : '<p class="muted center">No players match.</p>');
}

function statusBadge(p) {
  if (p.status === 'injured') return ' <span class="st st-inj">INJ</span>';
  if (p.status === 'suspended') return ' <span class="st st-sus">SUS</span>';
  return '';
}

function lineupView(m) {
  if (!m.confirmed) {
    return `<section class="card"><h2>Lineup</h2><p>Build and save a full 15-player squad first.</p>
      <button class="primary" data-tab="squad">Go to squad</button></section>`;
  }
  const { starters, bench, captain } = m.picks;
  const problems = xiProblems(starters);
  const sel = ui.selected && m.squad.includes(ui.selected) ? player(ui.selected) : null;
  const token = id => {
    const p = player(id);
    return `<button class="tok ${ui.selected === id ? 'sel' : ''}" data-action="pick" data-id="${id}">
      <span class="shirt pos-${p.position}">${p.club}${id === captain ? '<b class="cap">C</b>' : ''}</span>
      <span class="tname">${esc(shortName(p))}</span>
      <span class="tfx">${esc(fixtureText(p.club, state.currentGw) || money(p.price))}</span>
    </button>`;
  };
  const rows = ['FWD', 'MID', 'DEF', 'GK'].map(pos =>
    `<div class="pitch-row">${starters.filter(id => player(id).position === pos).map(token).join('')}</div>`).join('');

  return `${lockNote()}
  <section class="card">
    <div class="row between"><h2>GW ${state.currentGw} lineup</h2><span class="chip">${formation(starters)}</span></div>
    ${m.squad.length < SQUAD_SIZE ? `<div class="note">Squad has ${m.squad.length}/15 players – finish your transfer.</div>` : ''}
    ${problems.length ? `<div class="note warn">${problems.map(esc).join('<br>')}</div>` : ''}
    <div class="actionbar">${sel
      ? `<span><b>${esc(sel.name)}</b> – tap another player to swap</span>
         <span>${starters.includes(sel.id) && sel.id !== captain ? '<button class="primary" data-action="captain">Make captain</button>' : ''}
         <button data-action="deselect">Cancel</button></span>`
      : '<span class="muted">Tap a player to swap or make captain. Captain scores double.</span>'}</div>
    <div class="pitch">${rows}</div>
    <h3>Bench <span class="muted small">(auto-subs in this order)</span></h3>
    <ol class="bench">${bench.map((id, i) => {
      const p = player(id);
      return `<li class="${ui.selected === id ? 'sel' : ''}">
        <button class="bench-main" data-action="pick" data-id="${id}">
          <span class="pos pos-${p.position}">${p.position}</span> ${esc(p.name)} <small class="muted">${p.club}</small>
        </button>
        ${isLocked() ? '' : `<button class="mini" data-action="bench-up" data-id="${id}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">▲</button>
        <button class="mini" data-action="bench-down" data-id="${id}" ${i === bench.length - 1 ? 'disabled' : ''} aria-label="Move down">▼</button>`}
      </li>`;
    }).join('')}</ol>
  </section>`;
}

function resultsView(m) {
  const gws = scoredGws();
  const gw = ui.resultsGw && state.results[ui.resultsGw] ? ui.resultsGw : gws[gws.length - 1];
  const score = gw ? scoreGw(m, gw) : null;
  const res = gw ? state.results[gw] : null;

  const row = (l, counted) => {
    const p = player(l.id);
    const isCap = counted && l.id === score.captain;
    return `<tr class="${l.played ? '' : 'dnp'}">
      <td><span class="pos pos-${p.position}">${p.position}</span></td>
      <td>${esc(p.name)}${counted && score.subs.some(s => s.in === l.id) ? ' <span class="subon">sub</span>' : ''}${isCap ? ` <b class="cap-inline">C${score.captainPlays ? '×2' : ''}</b>` : ''}
        <div class="small muted">${l.played ? l.parts.map(([k, v]) => `${esc(k)} ${signed(v)}`).join(' · ') : 'Did not play'}</div></td>
      <td class="num">${counted ? l.points : `<span class="muted">${l.total}</span>`}</td>
    </tr>`;
  };

  return `<section class="card">
    <div class="row between"><h2>Gameweek ${state.currentGw}</h2>
      <button data-action="advance">Start GW ${state.currentGw + 1}</button></div>
    <p class="muted small">Import real stats for a gameweek. Players not in the file count as 0 minutes.</p>
    <form data-form="import" class="stack">
      <label class="row">GW <input name="gw" type="number" min="1" max="38" value="${state.currentGw}" class="gw-input"></label>
      <textarea name="csv" rows="4" placeholder="${STAT_HEADER}&#10;KAS-40,90,1,0,0,0,0,0,0,0,0"></textarea>
      <div class="row wrap">
        <button class="primary">Import pasted</button>
        <label class="filebtn">Upload CSV<input type="file" accept=".csv,text/csv,text/plain" data-action="stats-file" hidden></label>
        <button type="button" data-action="load-stats">Load data/stats_gwN.csv</button>
        <button type="button" data-action="template">Blank template</button>
      </div>
    </form>
  </section>
  ${gws.length ? `<section class="card">
    <div class="row between"><h2>${esc(m.name)}</h2>
      <select data-action="results-gw">${gws.map(g => `<option value="${g}" ${g === gw ? 'selected' : ''}>GW ${g}</option>`).join('')}</select></div>
    ${score ? `
      <div class="stats3">
        <div><span class="label">Points</span><strong>${score.gross}</strong></div>
        <div><span class="label">Hit</span><strong class="${score.hit ? 'neg' : ''}">${score.hit ? `−${score.hit}` : '0'}</strong></div>
        <div><span class="label">GW total</span><strong>${score.total}</strong></div>
      </div>
      ${score.subs.length ? `<div class="note">Auto-subs: ${score.subs.map(s => `${esc(player(s.in).name)} on for ${esc(player(s.out).name)}`).join('; ')}</div>` : ''}
      ${!score.captainPlays ? '<div class="note">Captain did not play – no double points.</div>' : ''}
      <table class="pts"><tbody>${score.lines.map(l => row(l, true)).join('')}</tbody></table>
      <h3>Bench</h3>
      <table class="pts bench-pts"><tbody>${score.bench.map(l => row(l, false)).join('') || '<tr><td class="muted">All bench players used</td></tr>'}</tbody></table>`
      : `<p class="muted">${esc(m.name)} had no saved squad for GW ${gw}.</p>`}
    ${res.unknownIds.length ? `<p class="small muted">Skipped unknown ids: ${res.unknownIds.slice(0, 20).map(esc).join(', ')}${res.unknownIds.length > 20 ? '…' : ''}</p>` : ''}
    <button class="danger small-btn" data-action="delete-results" data-gw="${gw}">Delete GW ${gw} results</button>
  </section>` : ''}`;
}

function leagueView(m) {
  const gws = scoredGws();
  const last = gws[gws.length - 1];
  const table = state.managers
    .map(x => ({ x, total: totalPoints(x), gw: last ? scoreGw(x, last)?.total ?? '–' : '–' }))
    .sort((a, b) => b.total - a.total);

  return `<section class="card">
    <h2>Mini league</h2>
    ${table.length ? `<table class="league"><thead><tr><th>#</th><th>Manager</th><th class="num">${last ? `GW${last}` : 'GW'}</th><th class="num">Total</th></tr></thead>
    <tbody>${table.map((r, i) => `<tr class="${r.x.id === state.activeId ? 'me' : ''}" data-action="activate" data-id="${r.x.id}">
      <td>${i + 1}</td><td>${esc(r.x.name)}${r.x.confirmed ? '' : ' <span class="muted small">(no squad)</span>'}</td>
      <td class="num">${r.gw}</td><td class="num"><b>${r.total}</b></td></tr>`).join('')}</tbody></table>
    <p class="muted small">Tap a manager to switch to them.</p>` : '<p class="muted">No managers yet.</p>'}
  </section>
  <section class="card">
    <h2>Managers <span class="muted small">${state.managers.length}/${MAX_MANAGERS}</span></h2>
    ${state.managers.length < MAX_MANAGERS ? `<form data-form="add-manager" class="row">
      <input name="name" placeholder="New manager name" maxlength="24" required>
      <button class="primary">Add</button></form>` : ''}
    <ul class="mgr-list">${state.managers.map(x => `<li>
      <span>${esc(x.name)}</span>
      <span><button class="mini" data-action="rename" data-id="${x.id}">Rename</button>
      <button class="mini danger" data-action="delete-manager" data-id="${x.id}">Delete</button></span></li>`).join('')}</ul>
  </section>
  <section class="card">
    <h2>Share</h2>
    <p class="muted small">Export the whole league to a file, send it to a friend, and they import it on their device. Importing adds or updates managers and results.</p>
    <div class="row wrap">
      <button data-action="export">Export league file</button>
      <label class="filebtn">Import league file<input type="file" accept=".json,application/json" data-action="league-file" hidden></label>
    </div>
    <p class="muted small">${DATA.players.length} players · ${DATA.players.filter(p => !p.verified).length} marked unverified · data from data/players.json</p>
    <button class="danger small-btn" data-action="reset">Reset everything</button>
  </section>`;
}

// ---------- Events ----------

function onClick(e) {
  const el = e.target.closest('[data-action],[data-tab]');
  if (!el || el.disabled) return;
  if (el.dataset.tab && !el.dataset.action) {
    ui.tab = el.dataset.tab;
    ui.selected = null;
    render();
    window.scrollTo(0, 0);
    return;
  }
  const m = activeManager();
  const id = el.dataset.id;
  const locked = isLocked();
  const editing = ['add', 'remove', 'confirm', 'pick', 'captain', 'bench-up', 'bench-down'];
  if (locked && editing.includes(el.dataset.action)) return toast('Locked – results are in for this gameweek');

  switch (el.dataset.action) {
    case 'add': addPlayer(m, id); break;
    case 'remove': removePlayer(m, id); break;
    case 'confirm': confirmSquad(m); break;
    case 'pos': ui.pos = el.dataset.pos; break;
    case 'pick':
      if (ui.selected && ui.selected !== id) { swap(m, ui.selected, id); ui.selected = null; }
      else ui.selected = ui.selected === id ? null : id;
      break;
    case 'deselect': ui.selected = null; break;
    case 'captain': m.picks.captain = ui.selected; ui.selected = null; save(); break;
    case 'bench-up': moveBench(m, id, -1); break;
    case 'bench-down': moveBench(m, id, 1); break;
    case 'advance':
      if (!confirm(`Finish GW ${state.currentGw} and start GW ${state.currentGw + 1}? Lineups for GW ${state.currentGw} will be frozen.`)) return;
      return advanceGw();
    case 'load-stats': {
      const gw = Number(document.querySelector('[name=gw]').value);
      fetch(`data/stats_gw${gw}.csv`, { cache: 'no-cache' })
        .then(r => { if (!r.ok) throw new Error(); return r.text(); })
        .then(text => importStats(gw, text))
        .catch(() => toast(`Couldn't load data/stats_gw${gw}.csv`));
      return;
    }
    case 'template': return download(`stats_gw${state.currentGw}.csv`, statsTemplate(), 'text/csv');
    case 'delete-results':
      if (!confirm(`Delete GW ${el.dataset.gw} results?`)) return;
      delete state.results[el.dataset.gw];
      ui.resultsGw = null;
      save();
      break;
    case 'activate': state.activeId = id; save(); break;
    case 'rename': {
      const x = state.managers.find(y => y.id === id);
      const name = prompt('New name', x.name);
      if (name && name.trim()) { x.name = name.trim().slice(0, 24); save(); }
      break;
    }
    case 'delete-manager': {
      const x = state.managers.find(y => y.id === id);
      if (!confirm(`Delete ${x.name} and their team?`)) return;
      state.managers = state.managers.filter(y => y.id !== id);
      if (state.activeId === id) state.activeId = state.managers[0]?.id || null;
      save();
      break;
    }
    case 'export':
      return download('j1-fantasy-league.json', JSON.stringify(state), 'application/json');
    case 'reset':
      if (!confirm('Delete all managers and results on this device?')) return;
      state = newState();
      save();
      break;
    default: return;
  }
  render();
}

function onSubmit(e) {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const data = new FormData(form);
  if (form.dataset.form === 'add-manager') {
    const name = String(data.get('name')).trim().slice(0, 24);
    if (!name) return;
    if (state.managers.length >= MAX_MANAGERS) return toast(`Max ${MAX_MANAGERS} managers`);
    const m = newManager(name);
    state.managers.push(m);
    state.activeId = m.id;
    ui.tab = 'squad';
    save();
    render();
  } else if (form.dataset.form === 'import') {
    importStats(Number(data.get('gw')), String(data.get('csv')));
  }
}

function onChange(e) {
  const el = e.target;
  if (el.id === 'manager-select') { state.activeId = el.value; ui.selected = null; save(); render(); }
  else if (el.id === 'f-club') { ui.club = el.value; renderPlayerList(activeManager()); }
  else if (el.id === 'f-sort') { ui.sort = el.value; renderPlayerList(activeManager()); }
  else if (el.dataset.action === 'results-gw') { ui.resultsGw = Number(el.value); render(); }
  else if (el.dataset.action === 'stats-file' && el.files[0]) {
    const gw = Number(document.querySelector('[name=gw]').value);
    el.files[0].text().then(text => importStats(gw, text));
  } else if (el.dataset.action === 'league-file' && el.files[0]) {
    el.files[0].text().then(importLeague);
  }
}

function onInput(e) {
  if (e.target.id === 'f-search') { ui.search = e.target.value; renderPlayerList(activeManager()); }
}

async function start() {
  try {
    await loadData();
  } catch (e) {
    $('#view').innerHTML = `<section class="card"><h2>Couldn't load data</h2>
      <p>The game reads <code>data/players.json</code> and <code>data/fixtures.json</code>. Browsers block that when the page is opened as a file, so serve the folder instead, e.g. <code>python3 -m http.server</code> and open <code>http://localhost:8000</code>.</p></section>`;
    return;
  }
  state = loadState();
  if (!activeManager()) state.activeId = state.managers[0]?.id || null;
  document.addEventListener('click', onClick);
  document.addEventListener('submit', onSubmit);
  document.addEventListener('change', onChange);
  document.addEventListener('input', onInput);
  render();
}

start();
