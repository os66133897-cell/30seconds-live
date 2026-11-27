import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { qrSvg } from './qr.mjs';
import { facilities, normalize as norm, canonicalFacility, staffKey, readImport, validateImport, staffWorkbook, resultWorkbook, readQuizWorkbook } from './workbooks.mjs';

const password = process.env.ADMIN_PASSWORD;
if (!password || password.length < 12) throw Error('ADMIN_PASSWORD에 12자 이상의 비밀번호를 설정하세요.');
const secure = process.env.RENDER === 'true' || process.env.COOKIE_SECURE === 'true';
const dataDir = resolve(process.env.DATA_DIR || 'data');
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, 'quiz.sqlite'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS game (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
const store = db.prepare('INSERT OR REPLACE INTO game VALUES (1, ?)');
const load = () => JSON.parse(db.prepare('SELECT value FROM game WHERE id=1').get()?.value || 'null');
const fresh = () => ({ staff: [], questions: [], players: [], phase: 'closed', index: -1, deadline: 0, remaining: 0, visibility: false });
let game = load() || fresh();
const sessions = new Map();
const streams = new Set();
const limits = new Map();
const hash = x => createHash('sha256').update(x).digest('hex');
const token = () => randomBytes(32).toString('hex');
function fail(message, status = 400) { throw Object.assign(Error(message), { status }); }
function field(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(label + ' 값을 확인하세요.');
  return value.trim().normalize('NFC');
}
function integer(value, min, max, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) fail(label + ' 범위를 확인하세요.');
  return number;
}
function staffRows(rows) {
  if (!Array.isArray(rows) || rows.length > 3000) fail('직원 명단 형식을 확인하세요.');
  const keys = new Set();
  return rows.map(row => {
    const name = field(row?.name, 80, '이름');
    const facility = canonicalFacility(row.facility);
    if (!facility) fail('소속 시설을 확인하세요.');
    const tag = String(row.tag ?? '').trim().toUpperCase();
    if (tag && !/^[A-Z]$/.test(tag)) fail('구분자는 영문 한 글자로 입력하세요.');
    const aliases = aliasList(row.aliases);
    const key = staffKey({name,facility,tag});
    if (keys.has(key)) fail('중복 직원이 있습니다. 이름과 소속이 같으면 구분자를 추가하세요.');
    keys.add(key);
    return { name, facility, tag, aliases };
  });
}
function aliasList(items) {
  if (items === undefined) return [];
  if (!Array.isArray(items) || items.length > 24) fail('별칭 목록을 확인하세요.');
  return items.map(item => field(item, 160, '별칭'));
}
function questionRows(rows) {
  if (!Array.isArray(rows) || rows.length > 100) fail('문제는 최대 100개까지 등록할 수 있습니다.');
  return rows.map(row => {
    const title = field(row?.title, 500, '문제');
    if (!['A','B'].includes(row.type)) fail('문제 유형을 확인하세요.');
    const seconds = integer(row.seconds ?? 30, 1, 600, '제한시간');
    const points = integer(row.points ?? 10, 1, 1000, '배점');
    if (row.type === 'B') return { title, type: 'B', seconds, points, answers: [] };
    if (!Array.isArray(row.answers) || !row.answers.length || row.answers.length > 500) fail('유형 A 정답은 1개 이상 500개 이하로 입력하세요.');
    const forms = new Set();
    const answers = row.answers.map(answer => {
      const name = field(answer?.name, 160, '정답');
      const aliases = aliasList(answer.aliases);
      for (const form of new Set([name,...aliases].map(norm))) {
        if (forms.has(form)) fail('같은 유형 A 문제에서 정답 또는 별칭이 겹칩니다.');
        forms.add(form);
      }
      return { name, aliases };
    });
    return { title, type: 'A', seconds, points, answers };
  });
}
function score(player, index) {
  return Object.values(player.hits[index] || {}).reduce((sum, hit) => sum + hit.points, 0);
}
function rankings() {
  const rows = game.players.map(player => ({
    id: player.id, name: player.name, facility: player.facility,
    count: Object.keys(player.hits[game.index] || {}).length,
    round: score(player,game.index),
    total: Object.keys(player.hits).reduce((sum,index) => sum + score(player,index),0)
  })).sort((a,b) => b.total-a.total || a.name.localeCompare(b.name,'ko'));
  let rank = 0;
  return rows.map((row,index) => {
    if (index===0 || rows[index-1].total!==row.total) rank=index+1;
    return { ...row, rank };
  });
}
function persist() {
  try { store.run(JSON.stringify(game)); }
  catch (error) { game = load() || fresh(); throw error; }
}
let expiry;
function schedule() {
  clearTimeout(expiry);
  if (game.phase === 'running') expiry = setTimeout(expire, Math.min(2147483647,Math.max(0,game.deadline-Date.now())));
}
function expire() {
  if (game.phase !== 'running') return;
  if (game.deadline > Date.now()) return schedule();
  game.phase = 'roundEnd';
  game.deadline = 0;
  commit();
}
function commit() {
  persist();
  schedule();
  queueBroadcast();
}
function readCookie(req, name) {
  return (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(name+'='))?.slice(name.length+1) || '';
}
function hasAdmin(key) { return (sessions.get(key) || 0) > Date.now(); }
function cookie(res, name, value, maxAge) {
  res.setHeader('Set-Cookie', name+'='+value+'; Path=/; HttpOnly; SameSite=Strict; Max-Age='+maxAge+(secure?'; Secure':''));
}
function playerFor(key) { return key ? game.players.find(player => player.key === key) : undefined; }
function context() {
  const connected = new Map();
  for (const stream of streams) {
    if (stream.role === 'player' && stream.key) connected.set(stream.key,(connected.get(stream.key)||0)+1);
  }
  const rows = rankings();
  const online=game.players.filter(player=>connected.has(player.key));
  return { connected, rows, online };
}
function view(role, key, ctx) {
  const question = game.questions[game.index];
  const showQuestion = ['running','paused','roundEnd'].includes(game.phase);
  const online = ctx.online;
  const shared = {
    now: Date.now(), phase: game.phase, index: game.index, rounds: game.questions.length,
    title: question && (showQuestion || role === 'admin') ? question.title : null,
    seconds: question?.seconds || 30, deadline: game.deadline, remaining: game.remaining,
    count: game.players.length, online: online.length, facilities
  };
  if (role === 'screen') {
    shared.top = game.visibility && (showQuestion || game.phase === 'ended')
      ? ctx.rows.filter(row => row.rank <= 10).map(({ rank,name,facility,total }) => ({rank,name,facility,total})) : [];
    return shared;
  }
  if (role === 'admin' && hasAdmin(key)) {
    return { ...shared, admin: true, visibility: game.visibility,
      facilitiesCount: facilities.map(facility => online.filter(player => player.facility === facility).length),
      ranking: ctx.rows.map(row => {
        const player = game.players.find(item => item.id === row.id);
        return { ...row, connections: ctx.connected.get(player.key)||0, duplicates: player.duplicates||0, repeatJoins: player.repeatJoins||0, limited: player.limited||0 };
      }) };
  }
  const player = role === 'player' ? playerFor(key) : undefined;
  const row = player && ctx.rows.find(item => item.id === player.id);
  return { ...shared, me: row ? {
    name: row.name, facility: row.facility, total: row.total, round: row.round,
    rank: game.phase === 'ended' ? row.rank : null, hits: Object.values(player.hits[game.index] || {}).map(hit => hit.name)
  } : null };
}
function send(stream, ctx) {
  if (stream.role === 'admin' && !hasAdmin(stream.key)) return stream.res.end();
  if (stream.res.writableLength > 128_000) return stream.res.destroy();
  stream.res.write('data: '+JSON.stringify(view(stream.role,stream.key,ctx))+'\n\n');
}
let pending;
function queueBroadcast() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    const ctx = context();
    for (const stream of streams) send(stream,ctx);
  },40);
}
setInterval(() => {
  const now = Date.now();
  for (const [key,expiry] of sessions) if (expiry <= now) sessions.delete(key);
  for (const [key,entry] of limits) if (entry.until <= now) limits.delete(key);
  queueBroadcast();
}, 12000).unref();
function allowed(key, max, ms) {
  const now = Date.now();
  let entry = limits.get(key);
  if (!entry || entry.until <= now) {
    if (limits.size >= 12000) return false;
    entry = { until: now+ms, count: 0 };
    limits.set(key,entry);
  }
  return ++entry.count <= max;
}
async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')) fail('JSON 형식이 필요합니다.',415);
  const maxSize = req.url === '/api/admin/restore' ? 20000000 : ['/api/admin/import-preview','/api/admin/import-quiz'].includes(req.url) ? 7500000 : 2000000;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxSize) fail('요청 파일이 너무 큽니다.',413);
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString());
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {}
  fail('JSON 요청을 확인하세요.');
}
function findAnswer(question, player, input) {
  const key = norm(input);
  if (question.type === 'A') {
    const index = question.answers.findIndex(answer => [answer.name,...answer.aliases].some(form => norm(form) === key));
    return index < 0 ? null : { id: index, name: question.answers[index].name };
  }
  const candidates = [];
  game.staff.forEach((staff,index) => {
    const display = staff.name+(staff.tag?' '+staff.tag:'');
    const forms = [staff.name,display,...staff.aliases];
    if (staff.tag) forms.push(staff.name+'('+staff.tag+')');
    if (forms.some(form => norm(form) === key || norm(form+'/'+staff.facility) === key)) candidates.push({ staff,index,display });
  });
  const eligible = candidates.filter(({staff}) => staff.facility !== player.facility);
  if (eligible.length > 1) return { ambiguous:true };
  if (!eligible.length) return null;
  const { index,display,staff } = eligible[0];
  return { id:index, name:display+'/'+staff.facility };
}
function control(action) {
  const phase = game.phase;
  const question = game.questions[game.index];
  const requirePhase = (...phases) => { if (!phases.includes(phase)) fail('현재 단계에서는 실행할 수 없습니다.',409); };
  switch(action) {
    case 'open': requirePhase('closed','open'); game.phase='open'; break;
    case 'close': requirePhase('open','closed'); game.phase='closed'; break;
    case 'game': requirePhase('closed','open');
      if (!game.questions.length || !game.players.length) fail('문제와 참가자를 먼저 등록하세요.');
      game.index=0; game.phase='ready'; break;
    case 'start': requirePhase('ready'); game.deadline=Date.now()+question.seconds*1000; game.phase='running'; break;
    case 'pause': requirePhase('running'); game.remaining=Math.max(0,game.deadline-Date.now()); game.deadline=0; game.phase='paused'; break;
    case 'resume': requirePhase('paused'); game.deadline=Date.now()+game.remaining; game.remaining=0; game.phase='running'; break;
    case 'stop': requirePhase('running','paused'); game.phase='roundEnd'; game.deadline=0; game.remaining=0; break;
    case 'next': requirePhase('roundEnd');
      if (game.index+1 >= game.questions.length) game.phase='ended';
      else { game.index++; game.phase='ready'; } break;
    case 'end': requirePhase('ready','running','paused','roundEnd'); game.phase='ended'; game.deadline=0; game.remaining=0; break;
    default: fail('알 수 없는 진행 명령입니다.');
  }
}
const configRevision=()=>hash(JSON.stringify([game.staff,game.questions]));
function rankedRounds() {
  const players = new Map(game.players.map(player => [player.id,player]));
  return rankings().map(row => ({
    ...row, rounds:game.questions.map((_,i)=>({
      count:Object.keys(players.get(row.id).hits[i]||{}).length,
      score:score(players.get(row.id),i)
    }))
  }));
}
function sendWorkbook(res, data, filename) {
  const date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(new Date());
  res.writeHead(200,{
    'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition':"attachment; filename=quiz-"+date+".xlsx; filename*=UTF-8''"+encodeURIComponent(filename+'-'+date+'.xlsx')
  });
  res.end(data);
}
function exportCsv() {
  const header = ['순위','이름','소속',...game.questions.flatMap((_,i)=>[(i+1)+'라운드 정답 수',(i+1)+'라운드 점수']),'총점'];
  const rows = rankings().map(row => {
    const player = game.players.find(item => item.id === row.id);
    return [row.rank,row.name,row.facility,...game.questions.flatMap((_,i)=>[Object.keys(player.hits[i]||{}).length,score(player,i)]),row.total];
  });
  return '\uFEFF'+[header,...rows].map(row => row.map(value => {
    const cell = String(value);
    return '"'+(/^[\s]*[=+@\-\t\r\n]/u.test(cell)?"'":'')+cell.replaceAll('"','""')+'"';
  }).join(',')).join('\r\n');
}

const assets = new Map([
  ['/', ['index.html','text/html']], ['/admin',['index.html','text/html']], ['/screen',['index.html','text/html']],
  ['/app.js',['app.js','text/javascript']], ['/style.css',['style.css','text/css']]
].map(([path,[file,type]]) => [path,[readFileSync(new URL('./public/'+file,import.meta.url)),type]]));
const server = createServer(async (req,res) => {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const json = (data,status=200) => { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(data)); };
  try {
    const url = new URL(req.url,'http://localhost');
    const path = url.pathname;
    const ip = req.socket.remoteAddress || 'unknown';
    const playerToken = readCookie(req,'player');
    const key = playerToken ? hash(playerToken) : '';
    const admin = readCookie(req,'admin');
    if (req.method === 'GET' && assets.has(path)) {
      const [content,type] = assets.get(path);
      res.writeHead(200,{'Content-Type':type+'; charset=utf-8'}); return res.end(content);
    }
    if (req.method === 'GET' && path === '/health') return json({ok:true});
    if (req.method === 'GET' && path === '/qr') {
      const origin = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
      const expected = origin || ((secure?'https':'http')+'://'+req.headers.host);
      const target = new URL('/',expected);
      if (Buffer.byteLength(target.href) > 106) fail('QR용 참여 주소는 106바이트 이하여야 합니다.');
      if (!allowed('qr:'+ip,400,60000)) fail('잠시 뒤 다시 시도하세요.',429);

      const svg = qrSvg(target.href);
      res.writeHead(200,{'Content-Type':'image/svg+xml'}); return res.end(svg);
    }
    if (path === '/events' && req.method === 'GET') {
      const role = url.searchParams.get('role') || 'player';
      if (!['admin','player','screen'].includes(role)) fail('화면 유형을 확인하세요.');
      if (role === 'admin' && !hasAdmin(admin)) fail('관리자 로그인이 필요합니다.',401);
      if (streams.size >= 450 || !allowed('sse:'+ip,1800,60000)) fail('연결이 많습니다. 잠시 뒤 다시 접속하세요.',429);
      const stream = {role,key:role==='admin'?admin:key,res};
      res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','X-Accel-Buffering':'no','Connection':'keep-alive','Cache-Control':'no-cache, no-transform'});
      res.write('retry: 1500\n\n');
      streams.add(stream);
      res.on('close',()=>{ streams.delete(stream); queueBroadcast(); });
      send(stream,context());
      queueBroadcast();
      return;
    }
    if (req.method === 'GET' && path === '/api/time') return json({now:Date.now()});
    if (path === '/api/state' && req.method === 'GET') return json(view('player',key,context()));
    if (path === '/api/login' && req.method === 'POST') {
      if (!allowed('login:'+ip,12,300000)) fail('로그인 시도가 많습니다. 5분 후 다시 시도하세요.',429);
      const data = await body(req);
      if (!timingSafeEqual(Buffer.from(hash(String(data.password ?? ''))),Buffer.from(hash(password)))) fail('비밀번호를 확인하세요.',401);
      sessions.delete(admin);
      const session = token();
      sessions.set(session,Date.now()+43200000);
      cookie(res,'admin',session,43200);
      return json({ok:true});
    }
    if (path === '/api/join' && req.method === 'POST') {
      if (!allowed('join:'+ip,850,60000)) fail('등록 요청이 많습니다. 잠시 뒤 다시 시도하세요.',429);
      const data = await body(req);
      expire();
      if (playerFor(key)) return json({ok:true});
      if (game.phase !== 'open') fail('현재 참가자를 모집하고 있지 않습니다.',409);
      const name = norm(field(data.name,80,'이름'));
      const tag = norm(data.tag);
      const people = game.staff.filter(row => norm(row.name)===name && row.facility===data.facility && (!tag || norm(row.tag)===tag));
      if (people.length !== 1) fail('등록된 이름과 소속을 확인하세요. 같은 시설의 동명이인은 구분자를 입력하세요.');
      const staff = people[0];
      const existing = game.players.find(row => row.name===staff.name && row.facility===staff.facility && row.tag===staff.tag);
      if (existing) { existing.repeatJoins=(existing.repeatJoins||0)+1; commit(); fail('이미 등록되었습니다. 처음 참여한 브라우저를 사용하세요.',409); }
      if (game.players.length >= 150) fail('참가 정원 150명이 찼습니다.',409);
      const access = token();
      game.players.push({ id:token().slice(0,20), key:hash(access), name:staff.name, facility:staff.facility,tag:staff.tag,hits:{} });
      commit();
      cookie(res,'player',access,604800);
      return json({ok:true});
    }
    if (path === '/api/answer' && req.method === 'POST') {
      const data = await body(req);
      const player = playerFor(key);
      if (!player) fail('참가자 등록이 필요합니다.',401);
      expire();
      if (game.phase !== 'running' || Date.now() >= game.deadline || data.index !== game.index) fail('현재 답안을 제출할 수 없습니다.',409);
      if (!allowed('answer:'+player.id,15,3000)) {
        if (!player.limited || allowed('audit:'+player.id,1,3000)) { player.limited=(player.limited||0)+1; commit(); }
        fail('제출이 너무 빠릅니다. 잠시 뒤 다시 시도하세요.',429);
      }
      const input = field(data.answer,160,'답안');
      const question = game.questions[game.index];
      const answer = findAnswer(question,player,input);
      if (answer?.ambiguous) return json({status:'ambiguous'});
      if (!answer) return json({status:'wrong'});
      const hits = player.hits[game.index] ||= {};
      if (hits[answer.id]) { player.duplicates=(player.duplicates||0)+1; commit(); return json({status:'duplicate'}); }
      hits[answer.id] = { name:answer.name,points:question.points };
      commit();
      return json({status:'correct',points:question.points,name:answer.name,round:score(player,game.index),total:Object.keys(player.hits).reduce((sum,index)=>sum+score(player,index),0)});
    }
    if (!path.startsWith('/api/admin/')) fail('페이지를 찾을 수 없습니다.',404);
    if (!hasAdmin(admin)) fail('관리자 로그인이 필요합니다.',401);
    if (req.method === 'GET') {
      if (path === '/api/admin/config') return json({staff:game.staff,questions:game.questions,revision:configRevision()});
      if (path === '/api/admin/staff-template') return sendWorkbook(res,await staffWorkbook(),'직원명단-등록양식');
      if (path === '/api/admin/staff-backup') {
        res.setHeader('Content-Disposition','attachment; filename="quiz-staff.json"');
        return json({staff:game.staff});
      }
      if (path === '/api/admin/results.xlsx') return sendWorkbook(res,await resultWorkbook(rankedRounds(),game.questions.length),'퀴즈-최종결과');
      if (path === '/api/admin/results') {
        res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="quiz-results.csv"'});
        return res.end(exportCsv());
      }
      if (path === '/api/admin/backup') {
        res.setHeader('Content-Disposition','attachment; filename="quiz-backup.json"');
        return json({version:1,game});
      }
      fail('페이지를 찾을 수 없습니다.',404);
    }
    if (req.method !== 'POST') fail('지원하지 않는 요청입니다.',405);
    const data = await body(req);
    if (!hasAdmin(admin)) fail('관리자 세션이 만료되었습니다.',401);
    expire();
    switch(path) {
      case '/api/admin/logout': sessions.delete(admin); cookie(res,'admin','',0); queueBroadcast(); return json({ok:true});
      case '/api/admin/control':
        if ((data.phase!==undefined && data.phase!==game.phase) || (data.index!==undefined && data.index!==game.index))
          fail('진행 상태가 바뀌었습니다. 화면이 갱신된 후 다시 시도하세요.',409);
        control(data.action);
        break;
      case '/api/admin/import-quiz': {
        if (!allowed('import:'+admin,15,60000)) fail('가져오기 요청이 많습니다. 잠시 후 다시 시도하세요.',429);
        if (game.index>=0||game.players.length) fail('참가자 등록 전에 통합 명단을 가져올 수 있습니다.',409);
        let incoming;
        try { incoming=await readQuizWorkbook(data); } catch(error) { fail(error.message); }
        if (!hasAdmin(admin)) fail('관리자 세션이 만료되었습니다.',401);
        if (game.index>=0||game.players.length) fail('참가자 등록 전에 통합 명단을 가져올 수 있습니다.',409);
        const staff=new Map(game.staff.map(row=>[staffKey(row),row]));
        for(const row of incoming.staff) if(!staff.has(staffKey(row)))staff.set(staffKey(row),row);
        const questions=new Map(game.questions.map(row=>[norm(row.title),row]));
        for(const row of incoming.questions)questions.set(norm(row.title),row);
        const nextStaff=staffRows([...staff.values()]);
        const nextQuestions=questionRows([...questions.values()]);
        game.staff=nextStaff;
        game.questions=nextQuestions;
        commit();
        return json({staff:incoming.staff.length,questions:incoming.questions.length,answers:incoming.questions.reduce((sum,q)=>sum+q.answers.length,0)});
      }
      case '/api/admin/import-preview': {
        if (!allowed('import:'+admin,15,60000)) fail('가져오기 요청이 많습니다. 잠시 후 다시 시도하세요.',429);
        const kind=data.kind;
        try {
          const records=await readImport(kind,data);
          if (!hasAdmin(admin)) fail('관리자 세션이 만료되었습니다.',401);
          const existing=kind==='staff'?game.staff:[];
          const validate=kind==='staff'? row=>staffRows([row]) : row=>questionRows([{title:'가져오기 확인',type:'A',answers:[row]}]);
          return json(validateImport(kind,records,existing,validate));
        } catch(error) { fail(error.message,error.status||400); }
        break;
      }
      case '/api/admin/visibility': game.visibility=data.visible===true; break;
      case '/api/admin/reset': {
        if (!['all','players'].includes(data.scope)) fail('초기화 범위를 선택하세요.');
        const previous=game;
        game=fresh();
        if (data.scope==='players') { game.staff=previous.staff; game.questions=previous.questions; }
        limits.clear();
        break;
      }
      case '/api/admin/config': {
        if(data.revision!==undefined && data.revision!==configRevision()) fail('다른 관리자 화면에서 설정을 수정했습니다. 새로고침한 후 다시 시도하세요.',409);
        if (game.index>=0) fail('게임 세션을 초기화한 뒤 편집하세요.',409);
        const staff = data.staff===undefined ? game.staff : staffRows(data.staff);
        const questions = data.questions===undefined ? game.questions : questionRows(data.questions);
        if (data.staff!==undefined && game.players.length) fail('참가자가 등록된 상태에서는 명단을 바꿀 수 없습니다.',409);
        game.staff=staff; game.questions=questions;
        break;
      }
      case '/api/admin/restore': {
        if (data.version!==1 || !data.game || typeof data.game !== 'object') fail('백업 파일을 확인하세요.');
        const source=data.game;
        const restored=fresh();
        restored.staff=staffRows(source.staff);
        restored.questions=questionRows(source.questions);
        if (!['closed','open','ready','running','paused','roundEnd','ended'].includes(source.phase)) fail('백업 진행 단계를 확인하세요.');
        restored.phase=source.phase;
        restored.index=integer(source.index,-1,restored.questions.length-1,'라운드');
        if ((restored.index===-1) !== ['open','closed'].includes(restored.phase)) fail('백업 라운드를 확인하세요.');
        restored.deadline=integer(source.deadline,0,9e15,'종료시간');
        restored.remaining=integer(source.remaining,0,600000,'남은 시간');
        restored.visibility=source.visibility===true;
        if (!Array.isArray(source.players) || source.players.length>150) fail('백업 참가자를 확인하세요.');
        const ids=new Set(), keys=new Set();
        restored.players=source.players.map(player=>{
          if (!/^[a-f0-9]{20}$/.test(player.id) || !/^[a-f0-9]{64}$/.test(player.key) || ids.has(player.id) || keys.has(player.key)) fail('백업 참가자 식별자를 확인하세요.');
          ids.add(player.id); keys.add(player.key);
          const [person]=staffRows([player]);
          if (!restored.staff.some(staff=>staff.name===person.name && staff.facility===person.facility && staff.tag===person.tag)) fail('백업 참가자와 명단을 확인하세요.');
          const hits={};
          for (const [round,entries] of Object.entries(player.hits||{})) {
            const index=integer(round,0,restored.index,'점수 라운드');
            const question=restored.questions[index];
            const max=(question.type==='A'?question.answers.length:restored.staff.length)-1;
            hits[index]={};
            for (const [id,hit] of Object.entries(entries)) {
              const answerId=integer(id,0,max,'정답 번호');
              if (hit.points!==question.points) fail('백업 배점을 확인하세요.');
              hits[index][answerId]={name:field(hit.name,240,'제출 내역'),points:question.points};
            }
          }
          return {...person,id:player.id,key:player.key,hits,
            duplicates:integer(player.duplicates||0,0,1e8,'중복 제출'),repeatJoins:integer(player.repeatJoins||0,0,1e8,'중복 등록'),limited:integer(player.limited||0,0,1e8,'제출 제한')};
        });
        game=restored; break;
      }
      default: fail('페이지를 찾을 수 없습니다.',404);
    }
    commit();
    if (path==='/api/admin/reset') db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    expire();
    return json({ok:true});
  } catch (error) {
    if (!error.status) console.error(error.message);
    if (!res.headersSent && !res.destroyed) json({error:error.status?error.message:'서버 오류가 발생했습니다.'},error.status||500);
    else res.end();
  }
});
server.requestTimeout=15000;
server.headersTimeout=10000;
expire();
schedule();
server.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('Quiz listening on '+server.address().port));





