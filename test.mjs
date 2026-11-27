import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import XLSX from 'xlsx';
import iconv from 'iconv-lite';
import ExcelJS from 'exceljs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

test('150명 동시 접속, 실시간 운영, 재시작 및 결과 검증',{timeout:90000},async t=>{
  const dir=mkdtempSync(join(tmpdir(),'quiz-integration-'));
  let server,base;
  const password='integration-only-78218';
  async function start() {
    server=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:'0',DATA_DIR:dir,ADMIN_PASSWORD:password,RENDER:'false',COOKIE_SECURE:'false'},stdio:['ignore','pipe','inherit']});
    const [output]=await once(server.stdout,'data');
    base='http://127.0.0.1:'+/listening on (\d+)/.exec(String(output))[1];
  }
  async function stop(){
    if(server && server.exitCode===null && server.signalCode===null){
      const exit=once(server,'exit');server.kill();await exit;
    }
  }
  t.after(async()=>{await stop();rmSync(dir,{recursive:true,force:true});});
  await start();
  async function request(path,data,cookie){
    const headers={};
    if(cookie)headers.Cookie=cookie;
    if(data!==undefined)headers['Content-Type']='application/json';
    const response=await fetch(base+path,{method:data===undefined?'GET':'POST',headers,body:data===undefined?undefined:JSON.stringify(data)});
    const type=response.headers.get('content-type');
    const result=type?.includes('application/json')?await response.json():type?.includes('spreadsheetml')?Buffer.from(await response.arrayBuffer()):await response.text();
    const access=response.headers.get('set-cookie')?.split(';')[0];
    return {status:response.status,result,access,headers:response.headers};
  }
  const ok=async(...args)=>{
    const result=await request(...args);
    assert.equal(result.status,200,JSON.stringify(result.result));
    return result;
  };
  const login=async()=> (await ok('/api/login',{password})).access;
  let admin=await login();
  const control=action=>ok('/api/admin/control',{action},admin);
  assert.equal((await request('/api/admin/config')).status,401);
  assert.equal((await request('/api/login',{password:'invalid'})).status,401);
  for(const path of ['/','/admin','/screen','/app.js','/style.css','/qr']) await ok(path);
  assert.match((await ok('/qr')).result,/viewBox="0 0 45 45"/);
  const preview=(kind,filename,bytes,encoding)=>ok('/api/admin/import-preview',{kind,filename,contents:bytes.toString('base64'),encoding},admin);
  const incomingBook=XLSX.utils.book_new();
  const incomingSheet=XLSX.utils.aoa_to_sheet([
    ['샘플 명단'],['사번','직원명','현소속','무관한 열','구분자'],
    [1,'  가상하늘   ','천청수','제외'],[],
    [2,'가상별빛','복커'],[3,'가상하늘','천안시청소년수련관'],
    [4,'가상오류','없는 시설'],[5,'','사무국']
  ]);
  XLSX.utils.book_append_sheet(incomingBook,incomingSheet,'입력 명단');
  for(const ext of ['xlsx','xls']){
    const bytes=XLSX.write(incomingBook,{type:'buffer',bookType:ext==='xls'?'biff8':'xlsx'});
    const previewed=(await preview('staff','명단.'+ext,bytes)).result;
    assert.deepEqual(previewed.rows.map(({line,name,facility})=>[line,name,facility]),[[3,'가상하늘','천안시청소년수련관'],[5,'가상별빛','청소년복합커뮤니티센터']]);
    assert.deepEqual(previewed.issues.map(issue=>issue.line),[6,7,8]);
    assert.match(previewed.issues[0].message,/이미/);
  }
  const source='성명,시설명,기타\r\n가상직원,태조산,제외\r\n';
  for(const [bytes,encoding] of [[Buffer.from(source),'auto'],[Buffer.from('\uFEFF'+source),'auto'],[iconv.encode(source,'cp949'),'auto'],[iconv.encode(source,'cp949'),'cp949'],[iconv.encode(source,'euc-kr'),'euc-kr']]){
    const {result}=await preview('staff','직원.csv',bytes,encoding);
    assert.equal(result.rows[0].name,'가상직원');
    assert.equal(result.rows[0].facility,'태조산청소년수련관');
  }
  const extended='이름,소속\n가상뷁,성정\n';
  assert.equal((await preview('staff','확장.csv',iconv.encode(extended,'cp949'))).result.rows[0].name,'가상뷁');
  const jsonStaff=(await preview('staff','직원.json',iconv.encode(JSON.stringify({staff:[{name:'가상구름',facility:'상담복지'}]}),'cp949'))).result;
  assert.equal(jsonStaff.rows[0].facility,'청소년상담복지센터');
  const paste=(await ok('/api/admin/import-preview',{kind:'staff',paste:' 가상햇살 / 학교밖\n\n가상설명/사무국'},admin)).result;
  assert.equal(paste.rows[1].line,3);
  assert.equal(paste.rows[0].facility,'학교밖청소년지원센터');
  await ok('/api/admin/config',{staff:paste.rows},admin);
  await ok('/api/admin/config',{staff:[{...paste.rows[0],name:'가상노을'},paste.rows[1]]},admin);
  assert.equal((await ok('/api/admin/config',undefined,admin)).result.staff[0].name,'가상노을');
  const template=await ok('/api/admin/staff-template',undefined,admin);
  assert.equal(template.result.readUInt32BE(0),0x504b0304);
  const answerBook=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(answerBook,XLSX.utils.aoa_to_sheet([['정답','별칭'],['가상직원1','첫 답'],['첫 답','중복']]),'정답표');
  const importedAnswers=(await preview('answers','답.xlsx',XLSX.write(answerBook,{bookType:'xlsx',type:'buffer'}))).result;
  assert.deepEqual(importedAnswers.issues.map(issue=>issue.line),[3]);
  const fake={kind:'staff',filename:'가짜.xlsx',contents:Buffer.from('wrong file').toString('base64')};
  assert.equal((await request('/api/admin/import-preview',fake,admin)).status,400);
  assert.equal((await request('/api/admin/import-preview',fake)).status,401);
  const staff=Array.from({length:151},(_,i)=>({name:'가상직원'+i,facility:i%2?'사무국':'천안시청소년수련관'}));
  staff[148]={name:'가상동명',facility:'태조산청소년수련관',tag:'A'};
  staff[149]={name:'가상동명',facility:'태조산청소년수련관',tag:'B'};
  const questions=[
    {title:'첫 문제',type:'A',seconds:20,points:10,answers:importedAnswers.rows},
    {title:'타 시설',type:'B',seconds:20,points:10},
    {title:'시간 만료',type:'B',seconds:1,points:5}
  ];
  await ok('/api/admin/config',{staff,questions},admin);
  await control('open');
  assert.equal((await request('/api/join',{name:'가상동명',facility:'태조산청소년수련관'})).status,400);
  const started=performance.now();
  const players=await Promise.all(staff.slice(0,150).map(async person=>(await ok('/api/join',person)).access));
  assert.equal(new Set(players).size,150);
  assert.equal((await request('/api/join',staff[150])).status,409);
  assert.equal((await request('/api/join',staff[0])).status,409);
  const sse=async(role,cookie)=>{
    const cancellation=new AbortController();
    const response=await fetch(base+'/events?role='+role,{headers:cookie?{Cookie:cookie}:{},signal:cancellation.signal});
    assert.equal(response.status,200);
    const reader=response.body.getReader();
    const decoder=new TextDecoder();
    let buffered='';
    return {
      close:()=>cancellation.abort(),
      async read(predicate) {
        for(;;){
          while(buffered.includes('\n\n')){
            const boundary=buffered.indexOf('\n\n');
            const frame=buffered.slice(0,boundary);
            buffered=buffered.slice(boundary+2);
            if(frame.startsWith('data: ')){
              const value=JSON.parse(frame.slice(6));
              if(predicate(value))return value;
            }
          }
          const {value,done}=await reader.read();
          assert.ok(!done,'SSE ended before expected state');
          buffered+=decoder.decode(value,{stream:true});
        }
      }
    };
  };
  // Each stream needs its own incremental UTF-8 decoder.
  const streamClients=await Promise.all(players.map(key=>sse('player',key)));
  const host=await sse('admin',admin);
  const screen=await sse('screen');
  const closeAll=()=>{streamClients.forEach(client=>client.close());host.close();screen.close();};
  t.after(closeAll);
  const connected=await host.read(value=>value.online===150);
  assert.equal(connected.count,150);
  await control('close');
  await control('game');
  await control('start');
  const [hostRunning,screenRunning,...clientStates]=await Promise.all([host,screen,...streamClients].map(stream=>stream.read(value=>value.phase==='running')));
  assert.equal(hostRunning.deadline,screenRunning.deadline);
  for(const state of clientStates){
    assert.equal(state.deadline,hostRunning.deadline);
    assert.equal(state.title,'첫 문제');
    assert.equal(state.answers,undefined);
    assert.equal(state.ranking,undefined);
  }
  const answer=(i,value,index=0)=>request('/api/answer',{answer:value,index},players[i]);
  assert.equal((await answer(0,'틀림')).result.status,'wrong');
  const outcomes=await Promise.all([answer(0,'  첫   답  '),answer(0,'가상직원1')]);
  assert.deepEqual(outcomes.map(item=>item.result.status).sort(),['correct','duplicate']);
  const burst=await Promise.all(players.slice(1).map((_,index)=>answer(index+1,'첫 답')));
  assert.ok(burst.every(item=>item.result.status==='correct'));
  const burstTime=Math.round(performance.now()-started);
  await control('pause');
  const [paused,otherPaused]=await Promise.all([host,streamClients[0]].map(stream=>stream.read(value=>value.phase==='paused')));
  assert.equal(paused.remaining,otherPaused.remaining);
  assert.equal(paused.deadline,0);
  assert.equal((await answer(0,'첫 답')).status,409);
  await control('resume');
  const resumed=await host.read(value=>value.phase==='running');
  assert.ok(resumed.deadline>Date.now());
  await control('stop');
  await control('next');
  await control('start');
  assert.equal((await answer(0,staff[2].name,1)).result.status,'wrong');
  assert.equal((await answer(0,staff[0].name,1)).result.status,'wrong');
  assert.equal((await answer(0,staff[1].name,1)).result.status,'correct');
  assert.equal((await answer(1,staff[0].name,1)).result.status,'correct');
  assert.equal((await answer(1,'없는 직원',1)).result.status,'wrong');
  assert.equal((await answer(2,'가상동명',1)).result.status,'ambiguous');
  assert.equal((await answer(2,'가상동명 (a)',1)).result.status,'correct');
  assert.equal((await answer(2,'가상동명 A/태조산청소년수련관',1)).result.status,'duplicate');
  assert.equal((await answer(3,'가상동명/태조산청소년수련관',1)).result.status,'ambiguous');
  const active=(await ok('/api/state',undefined,players[0])).result;
  assert.equal(active.me.total,20);
  const reconnect=await sse('player',players[0]);
  assert.equal((await reconnect.read(value=>value.phase==='running')).deadline,active.deadline);
  reconnect.close();
  closeAll();
  await stop();
  await start();
  assert.equal((await request('/api/admin/config',undefined,admin)).status,401);
  admin=await login();
  const resumedState=(await ok('/api/state',undefined,players[0])).result;
  assert.equal(resumedState.deadline,active.deadline);
  assert.equal(resumedState.me.total,20);
  assert.equal((await ok('/api/admin/config',undefined,admin)).result.staff.length,151);
  await control('stop');
  await control('next');
  await control('start');
  await delay(1150);
  assert.equal((await answer(0,staff[1].name,2)).status,409);
  await control('next');
  const final=(await ok('/api/state',undefined,players[0])).result;
  assert.equal(final.phase,'ended');
  assert.equal(final.me.rank,1);
  assert.equal((await ok('/api/state',undefined,players[1])).result.me.rank,1);
  assert.equal((await ok('/api/state',undefined,players[2])).result.me.rank,1);
  assert.equal((await ok('/api/state',undefined,players[3])).result.me.rank,4);
  const finalScreen=await sse('screen');
  t.after(finalScreen.close);
  assert.deepEqual((await finalScreen.read(value=>value.phase==='ended')).top,[]);
  await ok('/api/admin/visibility',{visible:true},admin);
  const shown=await finalScreen.read(value=>value.top.length>0);
  assert.equal(shown.top[0].rank,1);
  finalScreen.close();
  const result=await ok('/api/admin/results',undefined,admin);
  assert.match(result.result,/라운드 정답 수/);
  assert.match(result.result,/"1","가상직원0","천안시청소년수련관","1","10","1","10","0","0","20"/);
  const workbook=await ok('/api/admin/results.xlsx',undefined,admin);
  assert.match(workbook.headers.get('content-disposition'),/filename\*=UTF-8''.+\.xlsx/);
  assert.equal(workbook.result.readUInt32BE(0),0x504b0304);
  const decoded=XLSX.read(workbook.result,{type:'buffer'});
  assert.deepEqual(decoded.SheetNames,['최종 순위','라운드별 결과','시설별 참여 현황']);
  const standings=XLSX.utils.sheet_to_json(decoded.Sheets['최종 순위'],{header:1});
  assert.deepEqual(standings[1],['순위','이름','소속','전체 정답 수','총점']);
  assert.ok(standings.some(row=>row.join('|')==='1|가상직원0|천안시청소년수련관|2|20'));
  const facilityRows=XLSX.utils.sheet_to_json(decoded.Sheets['시설별 참여 현황'],{header:1});
  assert.equal(facilityRows.slice(2).reduce((total,row)=>total+row[1],0),150);
  const excelCheck=new ExcelJS.Workbook();
  await excelCheck.xlsx.load(workbook.result);
  assert.ok(excelCheck.getWorksheet('최종 순위').autoFilter);
  assert.equal(excelCheck.getWorksheet('최종 순위').getCell('A2').fill.fgColor.argb,'FF83F0B7');
  assert.equal(excelCheck.getWorksheet('라운드별 결과').getCell('B2').border.left.style,'thin');
  const backup=await ok('/api/admin/backup',undefined,admin);
  await ok('/api/admin/reset',{scope:'all'},admin);
  assert.equal((await ok('/api/state',undefined,players[0])).result.me,null);
  await ok('/api/admin/restore',backup.result,admin);
  assert.equal((await ok('/api/state',undefined,players[0])).result.me.total,20);
  await ok('/api/admin/reset',{scope:'players'},admin);
  const preserved=await ok('/api/admin/config',undefined,admin);
  assert.equal(preserved.result.staff.length,151);
  assert.equal((await ok('/api/state',undefined,players[0])).result.count,0);
  t.diagnostic('150 registrations, 150 player SSE connections and 151 answer submissions within '+burstTime+' ms');
});


