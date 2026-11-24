import os,json,time,secrets,threading,csv,io,unicodedata
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse
lock=threading.RLock(); config=[]; roster=[]; players={}; phase='wait'; idx=0; deadline=0; admin=os.environ.get('ADMIN_PASSWORD') or secrets.token_urlsafe(12)
F=['사무국','천안시청소년수련관','태조산청소년수련관','청소년복합커뮤니티센터','성정청소년문화의집','청소년상담복지센터','학교밖청소년지원센터']
def norm(s):
 return ''.join(unicodedata.normalize('NFC',str(s)).split()).replace('천안시청소년상담복지센터','청소년상담복지센터').replace('천안시학교밖청소년지원센터','학교밖청소년지원센터')
def tick():
 global phase
 if phase=='run' and time.time()>=deadline: phase='ended'
def state(p=None):
 tick(); d=config[idx] if config else {}; return dict(phase=phase,round=idx+1,total=len(config),question=d.get('q','') if phase in ('run','ended') else '',remaining=max(0,deadline-time.time()) if phase=='run' else 0,score=p['score'] if p else 0,count=len(players),points=d.get('p',10))
class H(BaseHTTPRequestHandler):
 def send(self,data,status=200,kind='application/json; charset=utf-8'):
  b=json.dumps(data,ensure_ascii=False).encode() if kind.startswith('application/json') else data; self.send_response(status);self.send_header('Content-Type',kind);self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b)
 def do_GET(self):
  path=urlparse(self.path).path
  if path in ('/','/admin'): self.send(Path(__file__).with_name('index.html').read_bytes(),kind='text/html; charset=utf-8')
  else:self.send({'error':'Not found'},404)
 def do_POST(self):
  global config,roster,phase,idx,deadline
  try:
   n=int(self.headers.get('Content-Length',0)); assert 0<n<2000000,'요청 크기 오류'; x=json.loads(self.rfile.read(n)); action=self.path[5:];
   with lock:
    tick(); p=players.get(x.get('token')); isadmin=secrets.compare_digest(str(x.get('password','')),admin)
    if action.startswith('admin'):
     assert isadmin,'관리자 비밀번호를 확인하세요.'
     if action=='adminImport':
      assert phase!='run','진행 중에는 변경할 수 없습니다.'; c=x['settings']['config']; r=x['settings']['roster']; assert isinstance(c,list) and c and isinstance(r,str),'설정 형식 오류'; new=[]
      for d in c:
       assert isinstance(d['q'],str) and d['q'].strip() and 1<=int(d['t'])<=600 and 1<=int(d['p'])<=1000 and d['mode'] in ('manual','other'),'문제 설정 오류'; a=[norm(v) for v in d.get('a','').replace(',','\n').splitlines() if v.strip()]; assert d['mode']=='other' or a,'인정 정답 누락'; new.append(dict(q=d['q'],t=int(d['t']),p=int(d['p']),mode=d['mode'],a=a))
      rr=[norm(v).split('/') for v in r.splitlines() if v.strip()]; assert all(len(v)==2 and v[0] and v[1] in F for v in rr),'직원 명단 형식 또는 소속 오류'; assert rr or all(d['mode']!='other' for d in new),'전체 명단 필요'; config=new;roster=rr;players.clear();idx=0;phase='wait'
     elif action=='adminStart':
      assert config and phase=='wait','대기 상태에서만 시작 가능합니다.';deadline=time.time()+config[idx]['t'];phase='run'
     elif action=='adminStop':
      assert phase=='run','진행 중인 문제가 없습니다.';phase='ended'
     elif action=='adminNext':
      assert phase=='ended','먼저 라운드를 종료하세요.'
      if idx+1>=len(config):phase='done'
      else:idx+=1;phase='wait'
     elif action=='adminReset':players.clear();idx=0;phase='wait'
     out=state();out['ranking']=sorted([dict(name=v['name'],facility=v['facility'],score=v['score']) for v in players.values()],key=lambda v:-v['score']);out['nextQuestion']=config[idx]['q'] if config else '';self.send(out);return
    if action=='join':
     assert config and phase=='wait' and idx==0,'현재 참가 등록 시간이 아닙니다.';name=norm(x['name']);f=norm(x['facility']);assert name and len(name)<=40 and f in F,'이름과 소속 확인';assert not any(v['name']==name and v['facility']==f for v in players.values()),'이미 등록된 참가자입니다.';token=secrets.token_urlsafe(24);p=dict(name=name,facility=f,score=0,seen={});players[token]=p;self.send(dict(token=token,**state(p)));return
    assert p,'참가 등록이 필요합니다.'
    if action=='answer':
     assert phase=='run' and x.get('round')==idx+1,'정답 입력 시간이 아닙니다.';d=config[idx];v=norm(x['answer']);seen=p['seen'].setdefault(idx,set());valid={n for n,f in roster if f!=p['facility'] and n!=p['name']} if d['mode']=='other' else set(d['a']);assert v in valid,'오답입니다. 다시 입력하세요.';assert v not in seen,'이미 입력한 정답입니다.';seen.add(v);p['score']+=d['p'];self.send(dict(message=f"정답! +{d['p']}점",**state(p)));return
    self.send(state(p))
  except Exception as e:self.send({'error':str(e) or '입력 오류'},400)
if __name__=='__main__':
 print('관리자 비밀번호:',admin,flush=True);ThreadingHTTPServer(('0.0.0.0',int(os.environ.get('PORT','8000'))),H).serve_forever()
