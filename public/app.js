const app = document.querySelector('#app');
const connection = document.querySelector('#connection');
const role = location.pathname === '/admin' ? 'admin' : location.pathname === '/screen' ? 'screen' : 'player';
document.body.classList.add(role);
const title = '30초의 기억';
const subtitle = '우리 재단 사람을 찾아라!';
const labels = {closed:'모집 대기',open:'참가자 모집 중',ready:'라운드 시작 대기',running:'라운드 진행 중',paused:'일시정지',roundEnd:'라운드 종료',ended:'게임 종료'};
const html = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const options = (facilities,value) => facilities.map(f=>'<option '+(f===value?'selected':'')+'>'+html(f)+'</option>').join('');
const asList = value => value.split('|').map(s=>s.trim()).filter(Boolean);
let state, config, feed, offset=0, connected=false, viewKey, submittedRound=-1;
const soundToggle=document.querySelector('#soundToggle');
const motion=matchMedia('(prefers-reduced-motion: reduce)');
const AudioEngine=window.AudioContext||window.webkitAudioContext;
let audio;
let soundEnabled=false;
if(AudioEngine){
  soundToggle.hidden=false;
  soundToggle.onclick=async()=>{
    if(soundEnabled){
      soundEnabled=false;
      await audio.suspend().catch(()=>{});
    }else{
      try{
        audio ||= new AudioEngine();
        await audio.resume();
        soundEnabled=true;
        chime('ready');
      }catch{return;}
    }
    soundToggle.textContent=soundEnabled?'효과음 켬':'효과음 끔';
    soundToggle.setAttribute('aria-pressed',String(soundEnabled));
  };
}
function chime(phase){
  if(!soundEnabled||audio?.state!=='running')return;
  const tones={ready:[440],running:[523,659,784],paused:[440,330],roundEnd:[523,392],ended:[523,659,784,1047]};
  const start=audio.currentTime;
  for(const [index,frequency] of (tones[phase]||[523,659]).entries()){
    const note=audio.createOscillator();
    const volume=audio.createGain();
    const at=start+index*.11;
    note.type='sine';note.frequency.value=frequency;
    volume.gain.setValueAtTime(.001,at);
    volume.gain.exponentialRampToValueAtTime(.095,at+.025);
    volume.gain.exponentialRampToValueAtTime(.001,at+.22);
    note.connect(volume);volume.connect(audio.destination);
    note.start(at);note.stop(at+.23);
  }
}
function showTransition(phase,playSound){
  if(playSound)chime(phase);
  if(motion.matches)return;
  (app.querySelector('.hero,.stage')||app).animate(
    [{opacity:.55,transform:'translateY(7px) scale(.99)'},{opacity:1,transform:'translateY(0) scale(1)'}],
    {duration:420,easing:'ease-out'});
  if(phase!=='ended'||role==='admin')return;
  const bursts=document.createElement('div');
  bursts.className='fireworks';bursts.setAttribute('aria-hidden','true');
  document.body.append(bursts);
  const colors=['#fbe350','#83f0b7','#ff8fa3','#8fd5ff','#fbf6c5'];
  for(let burst=0;burst<5;burst++){
    for(let ray=0;ray<17;ray++){
      const spark=document.createElement('i');
      const angle=ray*2*Math.PI/17+burst*.25;
      const radius=70+Math.random()*105;
      spark.style.left=[24,73,49,17,83][burst]+'%';
      spark.style.top=[36,31,21,60,53][burst]+'%';
      spark.style.background=colors[(burst+ray)%colors.length];
      bursts.append(spark);
      spark.animate([
        {opacity:1,transform:'translate(0,0) scale(.5)'},
        {opacity:1,offset:.22},
        {opacity:0,transform:'translate('+Math.cos(angle)*radius+'px,'+(Math.sin(angle)*radius+35)+'px) scale(.15)'}
      ],{duration:1150,delay:burst*230,fill:'both',easing:'ease-out'});
    }
  }
  setTimeout(()=>bursts.remove(),2400);
}

async function api(path,data) {
  const response=await fetch(path,data===undefined?undefined:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const result=await response.json();
  if (!response.ok) throw Object.assign(Error(result.error),{status:response.status});
  return result;
}
function message(id,text,kind='') {
  const field=document.getElementById(id);
  if (field) { field.textContent=text; field.dataset.kind=kind; }
}
function connect() {
  feed?.close();
  feed=new EventSource('/events?role='+role);
  feed.onmessage=event=>{
    const incoming=JSON.parse(event.data);
    const reconnect=!connected;
    if (reconnect) offset=incoming.now-performance.now();
    const previous=state;
    if(previous?.index!==incoming.index || !incoming.me)submittedRound=-1;
    state=incoming; connected=true;
    if (reconnect) syncClock();
    connection.textContent='실시간 연결'; connection.classList.add('online');
    render(); tick();
    if ((!previous && state.phase==='ended') || (previous && (previous.phase!==state.phase || previous.index!==state.index || Boolean(previous.me)!==Boolean(state.me)))) showTransition(state.phase,Boolean(previous));
  };
  feed.onerror=async()=>{
    connected=false;
    connection.textContent='다시 연결 중'; connection.classList.remove('online');
    tick();
    if(role==='admin' && tab==='live' && document.querySelector('#current'))updateLive();
    if (role==='admin' && feed.readyState===EventSource.CLOSED) {
      config=null; feed.close(); viewKey=null; login('다시 로그인해 주세요.');
    }
  };
}
function clock() {
  if (state.phase==='running') return Math.max(0,state.deadline-(performance.now()+offset));
  if (state.phase==='paused') return state.remaining;
  return state.phase==='ready' ? state.seconds*1000 : 0;
}
function tick() {
  if (!state) return;
  const left=clock();
  const timer=document.querySelector('#timer');
  if (timer) {
    const seconds=Math.ceil(left/1000);
    timer.textContent='00'.replace(/00/,String(Math.floor(seconds/60)).padStart(2,'0'))+':'+String(seconds%60).padStart(2,'0');
    timer.classList.toggle('urgent',seconds<=5 && seconds>0 && state.phase==='running');
    document.querySelector('#progress').value=left/(state.seconds*1000);
  }
  const form=document.querySelector('#answer');
  if (form) {
    const disabled=!connected || left<=0 || state.phase!=='running';
    form.elements.answer.readOnly=disabled;
    form.querySelector('button[type=submit]').disabled=disabled || form.dataset.busy==='true';
    form.querySelectorAll('[data-answer-tag]').forEach(button=>{button.disabled=disabled;});
  }
}
setInterval(tick,100);
async function syncClock() {
  if(!connected || document.hidden)return;
  const stream=feed;
  try {
    const start=performance.now();
    const result=await api('/api/time');
    const end=performance.now();
    if(stream===feed && connected && end-start<1500)offset=result.now-(start+end)/2;
  } catch {}
}
setInterval(syncClock,45000+Math.random()*15000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)syncClock();});
const timer=()=>'<div id="timer" class="timer"></div><progress id="progress" max="1" aria-label="남은 시간"></progress>';
const status=()=>'<span class="pill label">'+labels[state.phase]+'</span>';
const round=()=>state.index>=0?'라운드 '+(state.index+1)+' / '+state.rounds:'';
const count=()=>'<strong id="count"></strong>명 참가';
const intro=()=>'<h1>'+title+'<span>'+subtitle+'</span></h1>';
const rankCard=()=>'<section id="playerLeaders" class="card participant-leaders" hidden><h2>누적 순위 TOP 10</h2><ol id="playerTop"></ol></section>';
function showPlayerRanks(){
  const card=document.querySelector('#playerLeaders');
  if(!card)return;
  card.hidden=!(state.top?.length&&(state.phase==='ended'||submittedRound===state.index||state.me.hits?.length));
  if(!card.hidden)document.querySelector('#playerTop').innerHTML=state.top.map(row=>'<li><b>'+row.rank+'위</b><span>'+html(row.name)+' <small>'+html(row.facility)+'</small></span><strong>'+row.total+'점</strong></li>').join('');
}
const notice=(id)=>'<p id="'+id+'" class="feedback" role="status"></p>';
function render() {
  if (role==='admin') return renderAdmin();
  if (role==='screen') return renderScreen();
  const key=JSON.stringify([Boolean(state.me),state.phase,state.index,state.title]);
  if (key!==viewKey) {
    viewKey=key;
    if (!state.me) {
      app.innerHTML='<section class="hero">'+status()+intro()+'<p>동료의 이름을 떠올리고 제한시간 안에 정답을 맞혀 보세요.</p></section><section class="card join"><h2>퀴즈 참여하기</h2><p>'+count()+'</p><form id="join"><label>이름<input required name="name" maxlength="80" autocomplete="name" placeholder="이름 입력"></label><label>소속 시설<select name="facility" required><option value="">시설 선택</option>'+options(state.facilities)+'</select></label><details><summary>동명이인 구분자</summary><label>구분자<input name="tag" maxlength="1" placeholder="예 A"></label></details><button '+(state.phase==='open'?'':'disabled')+'>참여하기</button></form>'+notice('feedback')+'</section>';
      app.querySelector('#join').onsubmit=async event=>{
        event.preventDefault();
        const form=event.currentTarget;
        const button=form.querySelector('button');
        button.disabled=true;
        try { await api('/api/join',Object.fromEntries(new FormData(form))); connect(); }
        catch(error) { message('feedback',error.message,'wrong'); button.disabled=false; }
      };
    } else if (state.phase==='ended') {
      app.innerHTML='<section class="hero celebrate">'+status()+'<h1>퀴즈 완료!</h1><p>'+html(state.me.name)+' · '+html(state.me.facility)+'</p></section><section class="card scoreboard"><div><span>최종 순위</span><strong id="rank"></strong></div><div><span>총점</span><strong id="total"></strong></div></section>'+rankCard();
    } else {
      const active=['running','paused','roundEnd'].includes(state.phase);
      app.innerHTML='<section class="hero">'+status()+'<p>'+html(state.me.name)+' · '+html(state.me.facility)+'</p><h1>'+html(active?state.title:state.phase==='ready'?'곧 시작합니다':'잠시만 기다려 주세요')+'</h1><p>'+html(round())+' · '+count()+'</p>'+(active?timer():'')+'</section><section class="card play"><div class="scoreboard"><div><span>라운드 점수</span><strong id="roundScore"></strong></div><div><span>누적 점수</span><strong id="total"></strong></div></div>'+(active?'<form id="answer"><label>정답 입력<input name="answer" required maxlength="160" autocomplete="off" placeholder="직원 이름 또는 이름/소속"></label><button type="submit">제출</button><div class="answer-tags"><span>동명이인</span><button type="button" class="small ghost" data-answer-tag="A" aria-label="동명이인 A 붙이기">A 붙이기</button><button type="button" class="small ghost" data-answer-tag="B" aria-label="동명이인 B 붙이기">B 붙이기</button></div></form>'+notice('feedback')+'<h2>맞힌 정답</h2><ul class="hits" id="hits"></ul>':'<p>진행자가 라운드를 시작하면 문제가 나타납니다.</p>')+'</section>';
      if(active)app.insertAdjacentHTML('beforeend',rankCard());
      const form=app.querySelector('#answer');
      if (form) {
        const input=form.elements.answer;
        form.querySelectorAll('[data-answer-tag]').forEach(button=>{
          button.onclick=()=>{
            const [name,...facility]=input.value.trim().split('/');
            if(!name.trim()){message('feedback','이름을 먼저 입력해 주세요.');input.focus();return;}
            const tag=button.dataset.answerTag;
            const base=name.trim().replace(/\s+[AB]$|\s*\([AB]\)$/i,'');
            input.value=[base+' '+tag,...facility].join('/');
            input.focus({preventScroll:true});
          };
        });
        let composing=false, composingEnter=false;
        input.addEventListener('compositionstart',()=>{composing=true;});
        input.addEventListener('compositionend',()=>{composing=false;});
        input.addEventListener('keydown',event=>{
          if(event.key==='Enter' && (event.isComposing||event.keyCode===229||composing)) {
            composingEnter=true;
            setTimeout(()=>{composingEnter=false;},0);
          }
        });
        form.onsubmit=async event=>{
        event.preventDefault();
        if (composing || composingEnter || !connected || state.phase!=='running' || clock()<=0 || form.dataset.busy==='true') return;
        const answer=input.value.trim();
        if(!answer)return;
        form.dataset.busy='true'; input.value=''; tick(); input.focus({preventScroll:true});
        try {
          const result=await api('/api/answer',{index:state.index,answer});
          if (!form.isConnected) return;
          submittedRound=state.index;
          showPlayerRanks();
          const words={correct:'정답! +'+result.points+'점',wrong:'오답입니다. 다시 도전하세요.',duplicate:'이미 맞힌 정답입니다.',ambiguous:'동명이인입니다. 이름 A 또는 이름/소속으로 입력하세요.'};
          message('feedback',words[result.status],result.status);
          if (result.status==='correct') {
            if(result.total>state.me.total) {
              state.me.total=result.total;state.me.round=result.round;
              if(!state.me.hits.includes(result.name))state.me.hits.push(result.name);
              render();
            }
            if(!matchMedia('(prefers-reduced-motion: reduce)').matches)document.querySelector('#feedback').animate([{transform:'scale(.9)'},{transform:'scale(1.08)'},{transform:'scale(1)'}],350);
          }
        } catch(error) { if (form.isConnected) message('feedback',error.message,'wrong'); }
        finally { form.dataset.busy='false'; tick(); }
        };
      }
    }
  }
  for (const [id,value] of Object.entries({count:state.count,rank:state.me?.rank+'위',total:state.me?.total+'점',roundScore:state.me?.round+'점'})) {
    const element=document.getElementById(id);
    if (element) element.textContent=value;
  }
  showPlayerRanks();
  const hits=document.getElementById('hits');
  if (hits) hits.innerHTML=state.me.hits.map(item=>'<li>'+html(item)+'</li>').join('');
}
function renderScreen() {
  const key=JSON.stringify([state.phase,state.index,state.title,Boolean(state.top.length)]);
  if (key!==viewKey) {
    viewKey=key;
    const ended=state.phase==='ended';
    app.innerHTML='<section class="stage '+(ended?'celebrate':'')+'"><div class="stage-head"><div>'+status()+'<p>'+html(round())+'</p></div><button id="fullscreen" class="small">전체화면</button></div><div class="stage-body"><section class="stage-main">'+(state.title?'<h1>'+html(state.title)+'</h1>'+timer():intro())+'<p>'+count()+'</p></section><aside id="side">'+(['closed','open','ready'].includes(state.phase)?'<div class="qr"><img src="/qr" alt="퀴즈 참여 QR 코드"><a href="/">참여 주소</a></div>':'')+(state.top.length?'<section class="leaders"><h2>'+(ended?'최종 TOP 10':'실시간 순위')+'</h2><ol id="top"></ol></section>':'')+'</aside></div>'+(ended && state.top.length?'<section id="podium" class="podium" aria-label="1~3위 시상"></section>':'')+'</section>';
    app.querySelector('#fullscreen').onclick=()=>{
      if (document.fullscreenElement) document.exitFullscreen?.();
      else document.documentElement.requestFullscreen?.();
    };
  }
  document.querySelector('#count').textContent=state.count;
  const top=document.querySelector('#top');
  if (top) top.innerHTML=state.top.map(row=>'<li><b>'+row.rank+'위</b> '+html(row.name)+' <strong>'+row.total+'점</strong></li>').join('');
  const podium=document.querySelector('#podium');
  if (podium) podium.innerHTML=[1,2,3].map(rank=>{
    const winners=state.top.filter(row=>row.rank===rank);
    return winners.length?'<div><b>'+rank+'위</b><strong>'+winners.map(row=>html(row.name)).join(', ')+'</strong></div>':'';
  }).join('');
}
function login(error='') {
  connection.textContent='관리자 인증'; connection.classList.remove('online');
  app.innerHTML='<section class="hero">'+intro()+'</section><section class="card join"><h2>관리자 로그인</h2><form id="login"><label>관리자 비밀번호<input name="password" type="password" autocomplete="current-password" required></label><button>로그인</button></form>'+notice('feedback')+'</section>';
  message('feedback',error,'wrong');
  app.querySelector('#login').onsubmit=async event=>{
    event.preventDefault();
    const form=event.currentTarget;
    const button=form.querySelector('button');
    if(button.disabled)return;
    button.disabled=true;
    try { await api('/api/login',{password:form.elements.password.value}); await openAdmin(); }
    catch(error) { message('feedback',error.message,'wrong'); }
    finally {button.disabled=false;}
  };
}
const controls=[
  ['open','참가자 모집 시작',['closed']],['close','참가자 모집 마감',['open']],
  ['game','게임 시작',['closed','open']],['start','라운드 시작',['ready']],
  ['pause','타이머 일시정지',['running']],['resume','타이머 재개',['paused']],
  ['stop','라운드 강제 종료',['running','paused']],['next','다음 라운드',['roundEnd']],
  ['end','게임 종료',['ready','running','paused','roundEnd']]
];
let tab='live', selectedStaff=-1, selectedQuestion=-1;
let staffSearch='', playerSearch='';
async function openAdmin() {
  try { config=await api('/api/admin/config'); }
  catch(error) { if(error.status===401)return login(); throw error; }
  viewKey=null;
  connect();
}
function shell() {
  app.innerHTML='<section class="hero admin-hero"><div><span class="pill label">진행자 콘솔</span><h1>'+title+'</h1></div><div class="actions"><a class="button ghost" href="/" target="_blank" rel="noopener">참가 화면</a><a class="button ghost" href="/screen" target="_blank" rel="noopener">송출 화면</a><button id="logout" class="small">로그아웃</button></div></section><nav class="tabs" aria-label="관리 메뉴">'+[['live','실시간 운영'],['staff','직원 명단'],['questions','문제 관리'],['data','백업 및 결과']].map(([id,label])=>'<button data-tab="'+id+'" aria-pressed="'+(tab===id)+'">'+label+'</button>').join('')+'</nav>'+notice('adminMessage')+'<div id="panel"></div><dialog id="reset"><form method="dialog"><h2>게임 초기화</h2><p>선택한 데이터가 삭제됩니다.</p><div class="actions"><button value="cancel" type="submit">취소</button><button value="players" class="danger">참가자·점수 삭제</button><button value="all" class="danger">문제·명단까지 삭제</button></div></form></dialog>';
  app.querySelectorAll('[data-tab]').forEach(button=>button.onclick=()=>{tab=button.dataset.tab;viewKey=null;renderAdmin();});
  app.querySelector('#logout').onclick=async()=>{
    try { await api('/api/admin/logout',{}); feed.close(); config=null; viewKey=null; login(); }
    catch(error) { message('adminMessage',error.message,'wrong'); }
  };
  const reset=app.querySelector('#reset');
  reset.onclose=()=>{ if(reset.returnValue!=='cancel' && reset.returnValue) mutate('/api/admin/reset',{scope:reset.returnValue},true); };
  panel();
}
let adminBusy=false, requestedVisibility;
async function mutate(path,data,refresh=false) {
  if(adminBusy)return false;
  adminBusy=true;
  if(tab==='live')updateLive();
  message('adminMessage','요청을 처리하고 있습니다.');
  try {
    if(path==='/api/admin/config')data={...data,revision:config.revision};
    const result=await api(path,data);
    if (refresh) {
      config=await api('/api/admin/config');
      selectedStaff=selectedQuestion=-1;
      staffSelection.clear();
      panel();
    }
    const summary=path==='/api/admin/import-quiz'?'일괄 등록 완료 · 직원 '+result.staff+'명 · 문제 '+result.questions+'개 · 지정 정답 '+result.answers+'개':'저장했습니다.';
    message('adminMessage',summary,'correct');
    return true;
  } catch(error) {
    message('adminMessage',error.message,'wrong'); return false;
  } finally {
    adminBusy=false;
    if(tab==='live' && document.querySelector('#current'))updateLive();
  }
}
function renderAdmin() {
  if (!state?.admin || !config) return;
  if(viewKey!==tab) {viewKey=tab;shell();}
  if(tab==='live') updateLive();
}
function table(headers,body) {
  return '<div class="table-wrap"><table><thead><tr>'+headers.map(item=>'<th scope="col">'+item+'</th>').join('')+'</tr></thead><tbody>'+body+'</tbody></table></div>';
}
function panel() {
  const target=document.querySelector('#panel');
  if (!target) return;
  if (tab==='live') {
    target.innerHTML='<div class="dashboard"><section class="card"><h2>게임 제어</h2><div id="current"></div>'+timer()+'<div class="actions controls">'+controls.map(([id,label])=>'<button data-action="'+id+'">'+label+'</button>').join('')+'</div><div class="actions"><label class="check"><input id="visibility" type="checkbox"> 송출 화면 순위 공개</label><button class="danger" id="resetBtn">전체 게임 초기화</button></div></section><section class="card"><h2>시설별 접속 인원</h2><div id="facilitiesCount" class="facility-list"></div></section></div><section class="card"><div class="row-title"><h2>참가 현황 및 순위</h2><input id="playerSearch" aria-label="참가자 검색" placeholder="이름 또는 시설 검색" value="'+html(playerSearch)+'"></div><div id="ranking"></div></section>';
    target.querySelectorAll('[data-action]').forEach(button=>button.onclick=()=>mutate('/api/admin/control',{action:button.dataset.action,phase:state.phase,index:state.index}));
    target.querySelector('#visibility').onchange=async event=>{
      requestedVisibility=event.target.checked;
      if(!await mutate('/api/admin/visibility',{visible:requestedVisibility}))requestedVisibility=undefined;
      if(tab==='live')updateLive();
    };
    target.querySelector('#resetBtn').onclick=()=>{const dialog=document.querySelector('#reset');dialog.returnValue='cancel';dialog.showModal();};
    target.querySelector('#playerSearch').oninput=event=>{playerSearch=event.target.value;updateLive();};
    updateLive();
  } else if (tab==='staff') staffPanel(target);
  else if (tab==='questions') questionsPanel(target);
  else dataPanel(target);
}
function updateLive() {
  document.querySelector('#current').innerHTML=status()+' <b>'+html(round())+'</b><p>'+html(state.title||'')+'</p><p>접속 '+state.online+'명 / 등록 '+state.count+'명</p>';
  if(requestedVisibility===state.visibility)requestedVisibility=undefined;
  document.querySelector('#visibility').checked=requestedVisibility??state.visibility;
  document.querySelector('#visibility').disabled=adminBusy || !connected;
  document.querySelector('#resetBtn').disabled=adminBusy || !connected;
  for (const [id,label,phases] of controls) {
    const button=document.querySelector('[data-action="'+id+'"]');
    button.disabled=adminBusy || !connected || !phases.includes(state.phase);
    button.textContent=id==='next' && state.index+1===state.rounds?'최종 결과 발표':label;
  }
  document.querySelector('#facilitiesCount').innerHTML=state.facilities.map((facility,i)=>'<div>'+html(facility)+'<strong>'+state.facilitiesCount[i]+'명</strong></div>').join('');
  const rows=state.ranking.filter(row=>(row.name+' '+row.facility).includes(playerSearch));
  document.querySelector('#ranking').innerHTML=table(['순위','이름','소속','라운드 정답','라운드 점수','총점','연결','중복 등록','중복 제출','제한'],rows.map(row=>'<tr>'+[row.rank,row.name,row.facility,row.count,row.round,row.total,row.connections,row.repeatJoins,row.duplicates,row.limited].map(cell=>'<td>'+html(cell)+'</td>').join('')+'</tr>').join(''));
}
const canonical = value => String(value??'').normalize('NFKC').replace(/\s+/gu,'').toLowerCase();
const fileTypes = '.xlsx,.xls,.csv,.json';
const encodingPicker = '<label>CSV·JSON 인코딩<select class="encoding"><option value="auto">자동 감지</option><option value="utf8">UTF-8 / UTF-8 BOM</option><option value="cp949">CP949</option><option value="euc-kr">EUC-KR</option></select></label>';
async function readFile(file,encoding) {
  if (file.size<1 || file.size>5*1024*1024) throw Error('파일은 5MB 이하로 선택하세요.');
  const bytes=new Uint8Array(await file.arrayBuffer());
  let binary='';
  for(let i=0;i<bytes.length;i+=16384) binary+=String.fromCharCode(...bytes.subarray(i,i+16384));
  return {filename:file.name,contents:btoa(binary),encoding};
}
function showImport(node,result,kind,save) {
  const rows=result.rows;
  node.innerHTML='<h3>가져오기 미리보기</h3><p>등록 가능 '+rows.length+'건 · 오류 '+result.issues.length+'건</p>'
    +(result.issues.length?'<ul class="import-errors">'+result.issues.map(issue=>'<li>'+issue.line+'행 · '+html(issue.message)+'</li>').join('')+'</ul>':'')
    +(rows.length?table(kind==='staff'?['행','이름','소속','구분자','별칭']:['행','정답','별칭'],rows.map(row=>'<tr>'+[row.line,row.name,...(kind==='staff'?[row.facility,row.tag]:[]),row.aliases.join(' | ')].map(cell=>'<td>'+html(cell)+'</td>').join('')+'</tr>').join('')):'')
    +'<div class="actions"><button class="import-save" '+(!rows.length?'disabled':'')+'>'+(result.issues.length?'정상 행만 추가':'목록에 추가')+'</button><button class="ghost import-cancel">취소</button></div>';
  node.hidden=false;
  node.querySelector('.import-cancel').onclick=()=>{node.hidden=true;node.replaceChildren();};
  node.querySelector('.import-save').onclick=async event=>{
    event.currentTarget.disabled=true;
    try {
      const applied=await save(rows.map(({line,...row})=>row));
      if(applied){node.hidden=true;node.replaceChildren();}
      else if(node.isConnected)node.querySelector('.import-save').disabled=false;
    } catch(error) {
      message('adminMessage',error.message,'wrong');
      if(node.isConnected)node.querySelector('.import-save').disabled=false;
    }
  };
}
let facilityFilter='';
const staffSelection=new Set();
function staffPanel(target) {
  const record=config.staff[selectedStaff]||{};
  target.innerHTML='<div class="dashboard"><section class="card"><div class="row-title"><h2>직원 명단 · '+config.staff.length+'명</h2><button id="newStaff" class="small">직원 추가</button></div><div class="facility-list">'+state.facilities.map(f=>'<div>'+html(f)+'<strong>'+config.staff.filter(row=>row.facility===f).length+'명</strong></div>').join('')+'</div><div class="fields"><input id="staffSearch" aria-label="직원 검색" placeholder="이름 검색" value="'+html(staffSearch)+'"><select id="facilityFilter" aria-label="시설별 필터"><option value="">모든 시설</option>'+options(state.facilities,facilityFilter)+'</select></div><div class="actions"><button id="deleteSelected" class="small danger">선택 삭제</button><button id="deleteAllStaff" class="small danger">명단 전체 삭제</button><a class="button small ghost" href="/api/admin/staff-backup">명단 백업</a></div><div id="staffRows"></div></section><div><section class="card"><h2>'+(selectedStaff<0?'직원 추가':'직원 수정')+'</h2><form id="staffEdit"><label>이름<input name="name" required maxlength="80" value="'+html(record.name)+'"></label><label>시설<select name="facility">'+options(state.facilities,record.facility)+'</select></label><label>동명이인 구분자<input name="tag" maxlength="1" value="'+html(record.tag)+'"></label><label>별칭 (|로 구분)<input name="aliases" value="'+html(record.aliases?.join(' | '))+'"></label><button>직원 저장</button></form></section><section class="card"><h2>일괄 등록</h2><label>이름/소속/구분자/별칭 (한 줄에 한 명)<textarea id="bulkStaff" rows="4" placeholder="가상직원/사무국"></textarea></label><div class="actions"><button id="addBulk">붙여넣기 미리보기</button><a class="button ghost" href="/api/admin/staff-template">직원 명단 엑셀 양식</a></div>'+encodingPicker+'<label>엑셀·CSV·JSON 파일<input id="staffFile" type="file" accept="'+fileTypes+'"></label><section hidden class="preview" id="staffPreview"></section></section></div></div>';
  const save=staff=>mutate('/api/admin/config',{staff},true);
  function rows() {
    const filtered=config.staff.map((row,i)=>({...row,i}))
      .filter(row=>(!facilityFilter||row.facility===facilityFilter)&&canonical(row.name).includes(canonical(staffSearch)))
      .sort((a,b)=>a.name.localeCompare(b.name,'ko')||a.facility.localeCompare(b.facility,'ko')||a.tag.localeCompare(b.tag));
    target.querySelector('#staffRows').innerHTML=table(['선택','이름','시설','관리'],filtered.map(row=>'<tr><td><input type="checkbox" aria-label="'+html(row.name+' '+row.tag)+' 선택" data-select="'+row.i+'" '+(staffSelection.has(row.i)?'checked':'')+'></td><td>'+html(row.name+' '+row.tag)+'</td><td>'+html(row.facility)+'</td><td><button class="small" data-edit="'+row.i+'">수정</button> <button class="small danger" data-delete="'+row.i+'">삭제</button></td></tr>').join(''));
    target.querySelectorAll('[data-edit]').forEach(button=>button.onclick=()=>{selectedStaff=Number(button.dataset.edit);panel();});
    target.querySelectorAll('[data-delete]').forEach(button=>button.onclick=()=>{
      if(confirm('선택한 직원을 삭제할까요?')) save(config.staff.filter((_,i)=>i!==Number(button.dataset.delete)));
    });
    target.querySelectorAll('[data-select]').forEach(box=>box.onchange=()=>{
      const index=Number(box.dataset.select);
      if(box.checked)staffSelection.add(index);else staffSelection.delete(index);
      updateSelected();
    });
    updateSelected();
  }
  function updateSelected(){
    const button=target.querySelector('#deleteSelected');
    button.disabled=!staffSelection.size;
    button.textContent='선택 삭제 ('+staffSelection.size+')';
  }
  rows();
  target.querySelector('#staffSearch').oninput=event=>{staffSearch=event.target.value;rows();};
  target.querySelector('#facilityFilter').onchange=event=>{facilityFilter=event.target.value;rows();};
  target.querySelector('#newStaff').onclick=()=>{selectedStaff=-1;panel();target.querySelector('#staffEdit input').focus();};
  target.querySelector('#deleteSelected').onclick=()=>{if(staffSelection.size&&confirm(staffSelection.size+'명의 직원을 삭제할까요?'))save(config.staff.filter((_,i)=>!staffSelection.has(i)));};
  target.querySelector('#deleteAllStaff').onclick=()=>{if(config.staff.length&&confirm('직원 명단 '+config.staff.length+'명을 모두 삭제할까요?'))save([]);};
  target.querySelector('#staffEdit').onsubmit=event=>{
    event.preventDefault();
    const row=Object.fromEntries(new FormData(event.currentTarget));
    row.aliases=asList(row.aliases);
    const staff=[...config.staff];
    staff[selectedStaff<0?staff.length:selectedStaff]=row;
    save(staff);
  };
  async function preview(data) {
    const node=target.querySelector('#staffPreview');
    if(!node)return;
    node.hidden=false;node.textContent='명단을 확인하는 중입니다.';
    try {
      const result=await api('/api/admin/import-preview',{kind:'staff',...data});
      if(node.isConnected)showImport(node,result,'staff',rows=>save([...config.staff,...rows]));
    } catch(error) {node.textContent=error.message;}
  }
  target.querySelector('#addBulk').onclick=()=>preview({paste:target.querySelector('#bulkStaff').value});
  target.querySelector('#staffFile').onchange=async event=>{
    const input=event.currentTarget;
    const file=input.files[0];
    if(!file)return;
    try {await preview(await readFile(file,target.querySelector('.encoding').value));}
    catch(error){message('adminMessage',error.message,'wrong');}
    finally {input.value='';}
  };
}
function questionsPanel(target) {
  const question=config.questions[selectedQuestion]||{title:'',type:'A',seconds:30,points:10,answers:[]};
  target.innerHTML='<div class="dashboard"><section class="card"><div class="row-title"><h2>등록 문제 · '+config.questions.length+'개</h2><button id="newQuestion" class="small">문제 추가</button></div>'+table(['순서','문제','유형','정답','관리'],config.questions.map((q,i)=>'<tr><td>'+(i+1)+'</td><td>'+html(q.title)+'</td><td>'+q.type+'</td><td>'+(q.type==='A'?q.answers.length:'시설별')+'</td><td class="question-actions"><button class="small" data-edit="'+i+'">편집</button> <button class="small" data-up="'+i+'" '+(i===0?'disabled':'')+'>위</button> <button class="small" data-down="'+i+'" '+(i===config.questions.length-1?'disabled':'')+'>아래</button> <button class="small danger" data-delete="'+i+'">삭제</button></td></tr>').join(''))+'</section><section class="card"><h2>'+(selectedQuestion<0?'문제 추가':'문제 수정')+'</h2><form id="questionEdit"><label>문제 내용<textarea name="title" required rows="2">'+html(question.title)+'</textarea></label><label>문제 유형<select name="type"><option value="A">A · 지정 정답</option><option value="B" '+(question.type==='B'?'selected':'')+'>B · 타 시설 직원 찾기</option></select></label><div class="fields"><label>제한시간 (초)<input name="seconds" type="number" min="1" max="600" required value="'+question.seconds+'"></label><label>정답당 배점<input name="points" type="number" min="1" max="1000" required value="'+question.points+'"></label></div><label id="answerEditor">정답 목록 · 한 줄에 하나, 별칭은 |로 구분<textarea name="answers" rows="7" placeholder="가상이름 A | 별칭">'+html(question.answers.map(a=>[a.name,...a.aliases].join(' | ')).join('\n'))+'</textarea></label><div id="answerUpload">'+encodingPicker+'<label>정답 엑셀·CSV·JSON 파일<input name="answerFile" type="file" accept="'+fileTypes+'"></label><section hidden class="preview" id="answerImport"></section></div><p id="answerCount"></p><div class="actions"><button>문제 저장</button><button type="button" id="preview" class="ghost">미리보기</button></div></form><section id="questionPreview" class="preview" hidden></section></section></div>';
  const save=questions=>mutate('/api/admin/config',{questions},true);
  target.querySelector('#newQuestion').onclick=()=>{selectedQuestion=-1;panel();target.querySelector('[name=title]').focus();};
  target.querySelectorAll('[data-edit]').forEach(button=>button.onclick=()=>{selectedQuestion=Number(button.dataset.edit);panel();});
  target.querySelectorAll('[data-delete]').forEach(button=>button.onclick=()=>{if(confirm('선택한 문제를 삭제할까요?'))save(config.questions.filter((_,i)=>i!==Number(button.dataset.delete)));});
  for(const [direction,step] of [['up',-1],['down',1]]) target.querySelectorAll('[data-'+direction+']').forEach(button=>button.onclick=()=>{
    const index=Number(button.dataset[direction]);
    const questions=[...config.questions];
    [questions[index],questions[index+step]]=[questions[index+step],questions[index]];
    save(questions);
  });
  const form=target.querySelector('#questionEdit');
  const read=()=>{
    const row=Object.fromEntries(new FormData(form));
    row.answers=row.answers.split(/\r?\n/).map(asList).filter(a=>a.length).map(([name,...aliases])=>({name,aliases}));
    return row;
  };
  const update=()=>{
    const row=read();
    target.querySelector('#answerEditor').hidden=row.type==='B';
    target.querySelector('#answerUpload').hidden=row.type==='B';
    target.querySelector('#answerCount').textContent=row.type==='A'?'정답 '+row.answers.length+'개':'소속 시설을 기준으로 서버가 자동 채점합니다.';
  };
  form.oninput=update;update();
  form.elements.answerFile.onchange=async event=>{
    const input=event.currentTarget;
    const file=input.files[0];
    if(!file)return;
    const node=target.querySelector('#answerImport');
    node.hidden=false;node.textContent='정답을 확인하는 중입니다.';
    try {
      const result=await api('/api/admin/import-preview',{kind:'answers',...await readFile(file,form.querySelector('.encoding').value)});
      if(!node.isConnected)return;
      const known=new Set(read().answers.flatMap(row=>[row.name,...row.aliases].map(canonical)));
      result.rows=result.rows.filter(row=>{
        if(![row.name,...row.aliases].some(form=>known.has(canonical(form))))return true;
        result.issues.push({line:row.line,message:'편집 중인 정답 또는 별칭과 중복됩니다.'});
        return false;
      });
      showImport(node,result,'answers',rows=>{
        const combined=[...read().answers,...rows];
        const seen=new Set();
        for(const row of combined)for(const key of new Set([row.name,...row.aliases].map(canonical))){
          if(seen.has(key))throw Error('중복된 정답 또는 별칭을 확인하세요.');
          seen.add(key);
        }
        form.elements.answers.value=combined.map(row=>[row.name,...row.aliases].join(' | ')).join('\n');
        update();
        return true;
      });
    } catch(error){node.textContent=error.message;}
    finally {input.value='';}
  };
  form.onsubmit=event=>{
    event.preventDefault();
    const questions=[...config.questions];
    questions[selectedQuestion<0?questions.length:selectedQuestion]=read();
    save(questions);
  };
  target.querySelector('#preview').onclick=()=>{
    const row=read(), preview=target.querySelector('#questionPreview');
    preview.hidden=false;
    preview.innerHTML='<b>참가 화면 미리보기</b><h3>'+html(row.title||'문제 내용을 입력하세요')+'</h3><p>'+html(row.seconds)+'초 · 정답당 '+html(row.points)+'점</p>';
  };
}
function downloadJson(filename,data) {
  const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
  const anchor=document.createElement('a');
  anchor.href=url; anchor.download=filename; anchor.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function readJsonFile(file) {
  const bytes=await file.arrayBuffer();
  let text;
  try {text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
  catch {
    try {text=new TextDecoder('euc-kr',{fatal:true}).decode(bytes);}
    catch {throw Error('JSON 파일 인코딩을 확인하세요. UTF-8, CP949, EUC-KR을 지원합니다.');}
  }
  try {return JSON.parse(text.replace(/^\uFEFF/,''));}
  catch {throw Error('JSON 파일 형식을 확인하세요.');}
}
function dataPanel(target) {
  target.innerHTML='<div class="dashboard"><section class="card"><h2>경기 결과와 전체 백업</h2><div class="actions"><a class="button" href="/api/admin/results.xlsx">결과 엑셀 다운로드</a><a class="button ghost" href="/api/admin/results">결과 CSV 다운로드</a><a class="button ghost" href="/api/admin/backup">전체 백업 다운로드</a></div><p>전체 백업에는 직원 정보와 경기 기록이 포함됩니다.</p><label>전체 백업 복원<input id="restore" type="file" accept=".json"></label></section><section class="card"><h2>통합 엑셀 일괄 등록</h2><p>문제 목록, 문제별 정답, 전체 직원 명단이 담긴 XLSX 파일을 선택하세요.</p><label>통합 엑셀 파일<input id="quizFile" type="file" accept=".xlsx"></label><h2>문제 및 정답</h2><button id="exportQuestions">문제 JSON 내보내기</button><label>문제 JSON 불러오기<input id="importQuestions" type="file" accept=".json"></label></section></div>';
  target.querySelector('#quizFile').onchange=async event=>{
    const input=event.currentTarget;
    const file=input.files[0];
    if(!file)return;
    input.disabled=true;
    try {await mutate('/api/admin/import-quiz',await readFile(file,'auto'),true);}
    catch(error){message('adminMessage',error.message,'wrong');}
    finally {input.value='';input.disabled=false;}
  };
  target.querySelector('#exportQuestions').onclick=()=>downloadJson('quiz-questions.json',{questions:config.questions});
  for(const [id,path,transform] of [['restore','/api/admin/restore',data=>data],['importQuestions','/api/admin/config',data=>({questions:Array.isArray(data)?data:data.questions})]]){
    target.querySelector('#'+id).onchange=async event=>{
      const file=event.target.files[0];
      if(!file || !confirm('현재 데이터를 선택한 파일로 교체할까요?')) {event.target.value='';return;}
      try {
        const data=transform(await readJsonFile(file));
        if(id==='importQuestions' && !Array.isArray(data.questions))throw Error('문제 JSON을 확인하세요.');
        await mutate(path,data,true);
      } catch(error) {message('adminMessage',error.message,'wrong');}
      event.target.value='';
    };
  }
}
if(role==='admin') openAdmin().catch(error=>login(error.message));
else {
  app.innerHTML='<section class="hero">'+intro()+'<p>게임 서버에 연결 중입니다.</p></section>';
  connect();
}






