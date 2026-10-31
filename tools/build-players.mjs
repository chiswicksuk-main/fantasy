// Builds data/players.json.
//
//   node tools/build-players.mjs
//
// Source: data/seed.csv if it exists (and nothing else), otherwise tools/roster.csv.
// Columns (header row required, extra columns ignored):
//   club, name, position                         required
//   nameJa, number, role, price, status, verified, id, note   optional
// club is a club code from CLUBS below. position is GK/DEF/MID/FWD.
// If price is blank it is worked out by priceFor(role, position).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const CLUBS = [
  { id: 'KAS', name: 'Kashima Antlers', nameJa: '鹿島アントラーズ' },
  { id: 'MIT', name: 'Mito HollyHock', nameJa: '水戸ホーリーホック' },
  { id: 'URA', name: 'Urawa Red Diamonds', nameJa: '浦和レッズ' },
  { id: 'CHI', name: 'JEF United Chiba', nameJa: 'ジェフユナイテッド千葉' },
  { id: 'KSW', name: 'Kashiwa Reysol', nameJa: '柏レイソル' },
  { id: 'FCT', name: 'FC Tokyo', nameJa: 'FC東京' },
  { id: 'VER', name: 'Tokyo Verdy', nameJa: '東京ヴェルディ' },
  { id: 'MAC', name: 'FC Machida Zelvia', nameJa: 'FC町田ゼルビア' },
  { id: 'KAW', name: 'Kawasaki Frontale', nameJa: '川崎フロンターレ' },
  { id: 'YFM', name: 'Yokohama F. Marinos', nameJa: '横浜F・マリノス' },
  { id: 'SHI', name: 'Shimizu S-Pulse', nameJa: '清水エスパルス' },
  { id: 'NAG', name: 'Nagoya Grampus', nameJa: '名古屋グランパス' },
  { id: 'KYO', name: 'Kyoto Sanga', nameJa: '京都サンガF.C.' },
  { id: 'GAM', name: 'Gamba Osaka', nameJa: 'ガンバ大阪' },
  { id: 'CER', name: 'Cerezo Osaka', nameJa: 'セレッソ大阪' },
  { id: 'KOB', name: 'Vissel Kobe', nameJa: 'ヴィッセル神戸' },
  { id: 'OKA', name: 'Fagiano Okayama', nameJa: 'ファジアーノ岡山' },
  { id: 'HIR', name: 'Sanfrecce Hiroshima', nameJa: 'サンフレッチェ広島' },
  { id: 'FUK', name: 'Avispa Fukuoka', nameJa: 'アビスパ福岡' },
  { id: 'NGS', name: 'V-Varen Nagasaki', nameJa: 'V・ファーレン長崎' },
];

// Price in millions, by role and position.
//   star     – best players in the league, nailed starters
//   starter  – regular starters                      (stars + starters: 9–14)
//   solid    – solid starters / first-choice backups (6–8)
//   rotation – rotation players                      (4–5)
//   fringe   – fringe, youth, third/fourth GK        (3–4)
// Attackers cost more than defenders in the same role because they score more.
const PRICE_TABLE = {
  //          GK    DEF   MID   FWD
  star:     [10.0, 11.0, 12.5, 14.0],
  starter:  [ 9.0,  9.0,  9.5, 10.0],
  solid:    [ 6.0,  6.5,  7.0,  8.0],
  rotation: [ 4.0,  4.5,  5.0,  5.0],
  fringe:   [ 3.0,  3.5,  3.5,  4.0],
};
const POSITIONS = ['GK', 'DEF', 'MID', 'FWD'];

export function priceFor(role, position) {
  const row = PRICE_TABLE[role] || PRICE_TABLE.rotation;
  return row[POSITIONS.indexOf(position)];
}

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
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(v => v.trim() !== '')) rows.push(row);
  const header = rows.shift().map(h => h.trim());
  return rows.map(r => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

const slug = s => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const truthy = v => ['1', 'true', 'yes', 'y'].includes(String(v).toLowerCase());

const seedPath = join(root, 'data', 'seed.csv');
const sourcePath = existsSync(seedPath) ? seedPath : join(root, 'tools', 'roster.csv');
const rows = parseCsv(readFileSync(sourcePath, 'utf8'));

const clubIds = new Set(CLUBS.map(c => c.id));
const ids = new Set();
const errors = [];

const players = rows.map((r, i) => {
  const line = i + 2;
  if (!clubIds.has(r.club)) errors.push(`line ${line}: unknown club "${r.club}"`);
  if (!POSITIONS.includes(r.position)) errors.push(`line ${line}: bad position "${r.position}"`);
  if (!r.name) errors.push(`line ${line}: missing name`);
  const id = r.id || (r.number ? `${r.club}-${r.number}` : `${r.club}-${slug(r.name)}`);
  if (ids.has(id)) errors.push(`line ${line}: duplicate id "${id}"`);
  ids.add(id);
  const role = r.role || 'rotation';
  return {
    id,
    name: r.name,
    nameJa: r.nameJa || '',
    club: r.club,
    position: r.position,
    price: r.price ? Number(r.price) : priceFor(role, r.position),
    status: r.status || 'unknown',
    verified: truthy(r.verified),
    ...(r.number ? { number: Number(r.number) } : {}),
    role,
    ...(r.note ? { note: r.note } : {}),
  };
});

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}

const out = {
  season: '2026/27',
  source: sourcePath.endsWith('seed.csv') ? 'data/seed.csv' : 'tools/roster.csv',
  clubs: CLUBS,
  players,
};
// One club / player per line keeps the file readable and diffs small.
const list = arr => '[\n' + arr.map(x => '  ' + JSON.stringify(x)).join(',\n') + '\n ]';
writeFileSync(join(root, 'data', 'players.json'),
  `{\n "season": ${JSON.stringify(out.season)},\n "source": ${JSON.stringify(out.source)},\n` +
  ` "clubs": ${list(out.clubs)},\n "players": ${list(out.players)}\n}\n`);
console.log(`Wrote ${players.length} players from ${out.source} ` +
  `(${players.filter(p => !p.verified).length} unverified).`);
