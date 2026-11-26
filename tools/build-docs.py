"""검증 증빙과 실제 SQLite 스키마로 한국어 MD 및 편집 가능한 DOCX를 생성합니다."""
from pathlib import Path
import json, sqlite3, re, math
from PIL import Image, ImageDraw, ImageFont
from docx import Document
from docx.shared import Inches, Pt, Cm, RGBColor
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'docs'; OUT.mkdir(exist_ok=True)
FONT='C:/Windows/Fonts/malgun.ttf'
TEAL='#087f8c'; INK='#162b42'

def diagram(name,title,boxes,edges,footer,size=(1800,1100)):
    """레이아웃을 고정한 PNG 도식을 그립니다. 선은 노드보다 먼저 그립니다."""
    img=Image.new('RGB',size,'#f6f9fc'); d=ImageDraw.Draw(img)
    font=lambda n:ImageFont.truetype(FONT,n)
    d.text((70,45),title,font=font(40),fill=INK)
    d.text((70,105),'OpsMate  |  2026년 11월 26일',font=font(20),fill='#70849a')
    for a,b,label in edges:
        x,y,w,h,*_=boxes[a]; X,Y,W,H,*_=boxes[b]
        if abs(X-x)>abs(Y-y): start=(x+w,y+h/2) if X>x else (x,y+h/2); end=(X,Y+H/2) if X>x else (X+W,Y+H/2)
        else: start=(x+w/2,y+h) if Y>y else (x+w/2,y); end=(X+W/2,Y) if Y>y else (X+W/2,Y+H)
        d.line([start,end],fill='#a6b9c9',width=3)
        angle=math.atan2(end[1]-start[1],end[0]-start[0]); p1=(end[0]-14*math.cos(angle-.5),end[1]-14*math.sin(angle-.5));p2=(end[0]-14*math.cos(angle+.5),end[1]-14*math.sin(angle+.5));d.polygon([end,p1,p2],fill='#7e96aa')
        if label:
            mx=(start[0]+end[0])/2;my=(start[1]+end[1])/2;bounds=d.textbbox((0,0),label,font=font(19));tw=bounds[2];d.rectangle((mx-tw/2-7,my-15,mx+tw/2+7,my+15),fill='#f6f9fc');d.text((mx-tw/2,my-15),label,font=font(19),fill='#557188')
    for x,y,w,h,head,lines in boxes:
        d.rounded_rectangle((x,y,x+w,y+h),radius=14,fill='white',outline='#c9d9e5',width=2)
        d.rounded_rectangle((x,y,x+w,y+52),radius=14,fill=INK)
        d.rectangle((x,y+28,x+w,y+52),fill=INK)
        d.text((x+18,y+10),head,font=font(25),fill='white')
        for i,line in enumerate(lines):d.text((x+18,y+70+i*33),line,font=font(21),fill='#3a536c')
    d.text((70,size[1]-60),footer,font=font(21),fill='#60788e')
    img.save(OUT/f'{name}.png')

diagram('시스템아키텍처','시스템 아키텍처',[
 (70,200,360,220,'운영자 브라우저',['HTML CSS JavaScript','대시보드 및 장애 처리','세션 쿠키 및 WebSocket']),
 (560,190,600,270,'OpsMate Node.js 24',['인증 및 RBAC · REST API','실제 수집 · 임계치 감지 · 로그 검색','장애 이력 · 감사 · 운영 보고서','AI 명령 실행 기능 없음']),
 (1300,190,400,240,'저장소',['SQLite 기본 · WAL','MariaDB 선택적 확장','출처별 지표와 장애 기록']),
 (70,670,360,230,'실제 호스트와 에이전트',['OS 지표 및 선택 로그 파일','서버별 수집 토큰','가상 데모 생성기는 별도']),
 (560,670,600,230,'근거 검색 및 응답 검증',['한국어 BM25 · 임베딩 · RRF','운영 매뉴얼 5개 · 문서 ID 검증','실패 시 원문 안내 또는 답변 보류']),
 (1300,670,400,230,'로컬 Ollama',['생성 kanana2 3b','임베딩 embeddinggemma','기본 CPU 실행'])
],[(0,1,'HTTP / WS'),(1,2,'매개변수 SQL'),(3,1,'지표 및 로그'),(1,4,'분석 요청'),(4,5,'로컬 API')],'실제 및 가상 데이터 분리  |  단일 인스턴스 설계  |  Docker 실행 설정 제공')
diagram('ERD','데이터 관계도',[
 (60,190,450,210,'users',['PK id · UNIQUE username','password_hash · role']),
 (60,510,450,210,'sessions',['PK token_hash','FK user_id → users.id','expires_at']),
 (660,190,450,210,'servers',['PK id · UNIQUE name','hostname · source · enabled','token_hash · created_at']),
 (1270,190,460,230,'metrics / logs',['PK id · FK server_id','지표 또는 로그 본문','source · 수집 시각']),
 (660,590,450,270,'incidents',['PK id · FK server_id','category · severity · status','UNIQUE active_key','opened_at · resolved_at']),
 (1270,590,460,270,'incident_events / analyses',['PK id · FK incident_id','처리자와 상태·메모','분석 모드·본문·인용']),
 (60,820,450,150,'audit',['PK id · actor · action','detail · created_at'])
],[(0,1,'1 : N'),(2,3,'1 : N'),(2,4,'1 : N'),(4,5,'1 : N')],'총 9개 테이블  |  audit.actor는 계정명 스냅샷이며 외래키가 아님  |  active_key는 해결 시 NULL')
diagram('순서도','장애 감지 및 대응 순서',[
 (100,190,600,150,'1 지표 및 로그 수집',['실제 호스트 / 토큰 에이전트 / 가상 데모']),
 (100,430,600,170,'2 입력 검증 및 출처 확정',['허용 범위 · 인증 · 활성 상태 검사','값 미수집은 null 유지']),
 (100,700,600,180,'3 장애 분류 및 중복 억제',['CPU RAM Disk / ERROR / HEARTBEAT','미해결 서버·분류별 한 건 유지']),
 (1000,190,650,180,'4 담당자 분석 요청',['매뉴얼 BM25 및 선택 임베딩 검색','근거 없으면 답변 보류']),
 (1000,470,650,180,'5 모델 생성 및 인용 검증',['모델 오류는 매뉴얼 원문 안내','자동 명령 실행 없음']),
 (1000,760,650,180,'6 운영자 확인 및 해결',['원인과 대응 검토 · 승인 후 수동 조치','처리 메모 · 감사 로그 · 보고서 반영'])
],[(0,1,''),(1,2,''),(2,3,'장애 등록'),(3,4,''),(4,5,'담당자 검토')],'수집은 반복 실행  |  모델 제안이 서버 명령으로 연결되는 경로는 없음')

evaluation=json.loads((ROOT/'evidence/rag-evaluation.json').read_text('utf-8'))
live=json.loads((ROOT/'evidence/ai-live-evaluation.json').read_text('utf-8')) if (ROOT/'evidence/ai-live-evaluation.json').exists() else {'model_answers':0,'total':0}
ui=json.loads((ROOT/'evidence/ui-check.json').read_text('utf-8'))
release=json.loads((ROOT/'evidence/release-status.json').read_text('utf-8')) if (ROOT/'evidence/release-status.json').exists() else {}
docs={}
def section(title,paragraphs=(),table=None,image=None):return {'title':title,'paragraphs':list(paragraphs),'table':table,'image':image}
def doc(name,intro,sections):docs[name]={'intro':intro,'sections':sections}
reqs=[
 ['FR01','인증 및 권한','로그인·세션·계정·역할·감사','admin / operator / viewer'],
 ['FR02','서버 관리','등록·활성·비활성·토큰 발급','admin 전용'],
 ['FR03','실시간 지표','CPU RAM Disk RX TX 및 추이','local / agent / demo 분리'],
 ['FR04','로그 수집 검색','토큰 수집·레벨·부분 문자열 검색','최신 200건'],
 ['FR05','자동 감지','임계치·ERROR·수집 중단·중복 억제','미해결 분류별 1건'],
 ['FR06','근거 기반 AI','가설·확인·대응·인용·실패 대체','담당자 검토 필요'],
 ['FR07','장애 처리','접수·확인·해결·메모·이력','admin / operator'],
 ['FR08','관제와 통계','WebSocket·출처별 집계·보고서','JSON 다운로드']]
doc('요구사항분석서','OpsMate는 지표 확인, 장애 분류, 매뉴얼 탐색, 처리 이력 기록을 하나의 관제 흐름으로 연결하는 포트폴리오용 시스템이다. 실제 수집 데이터와 가상 데모를 구분하고 AI 제안을 운영자가 검토하도록 설계했다.',[
 section('개발 배경과 해결 대상',['운영자는 지표, 로그, 대응 매뉴얼을 서로 다른 화면에서 확인할 때 장애 시점의 맥락을 놓치기 쉽다. 이 프로젝트는 출처가 표시된 지표와 장애 이력을 한 화면에서 확인하고, 관련 매뉴얼을 찾는 작업을 지원한다.','현업 장애 감소 효과나 대응 시간 단축은 측정하지 않았다. 이번 결과물의 수용 기준은 실행 가능성, 데이터 출처 구분, 권한 분리, 근거 인용, 재현 가능한 테스트다.']),
 section('사용자와 운영 시나리오', ['관리자는 계정·역할·서버·수집 설정을 관리한다. 운영자는 지표와 로그를 확인하고 장애 분석 및 처리 메모를 남긴다. 조회자는 대시보드·로그·매뉴얼·운영 보고서를 열람한다.','대표 시나리오는 가상 디스크 공간 부족 감지 → 장애 상세 조회 → 매뉴얼 및 AI 분석 확인 → 담당자 승인 후 외부에서 수동 조치 → 해결 메모 기록이다. 시스템 자체는 삭제나 재시작을 실행하지 않는다.'],table=(['구분','필요 작업','권한 범위'],[['관리자','서버 등록·계정 운영·감사','모든 관리 기능'],['운영자','장애 확인·분석·해결','운영 API'],['조회자','현재 상태와 보고서 확인','읽기 전용']])),
 section('기능 범위',table=(['ID','기능','처리 내용','제약'],reqs)),
 section('비기능 요구와 제외 범위',['Node.js 24, SQLite, 외부 CDN 없는 웹 화면을 기본 실행 환경으로 한다. MariaDB 어댑터와 Docker 실행 설정을 확장 지점으로 제공한다. Redis, 다중 인스턴스, 자동 복구, 이메일·메신저 알림은 이번 범위에 포함하지 않는다.','보안은 scrypt 비밀번호 해시, 서버 측 RBAC, 세션 토큰 해시, Origin 검사, 크기 제한, 매개변수 SQL, 인증 WebSocket, 감사 로그를 포함한다. 운영용 TLS 프록시, 계정 복구, MFA, 장기 부하 검증은 별도 운영 구축 과제다.','외부 호스트 전체에 대한 자동 탐색은 수행하지 않는다. 원격 호스트는 관리자가 등록하고 에이전트가 능동적으로 지표를 전송한다.'])])

apirows=[['POST','/api/login','전체','세션 쿠키 발급'],['GET','/api/me','인증','사용자 역할'],['POST','/api/logout','인증','세션 폐기'],['POST','/api/password','인증','비밀번호 변경·세션 폐기'],['GET','/api/snapshot','인증','서버·장애 최신 상태'],['POST','/api/servers','관리자','서버 등록·토큰 1회 발급'],['PATCH','/api/servers/:id','관리자','수집 활성 변경'],['GET','/api/metrics?serverId=','인증','최근 120개 지표'],['GET','/api/logs?q=&level=','인증','로그 검색'],['POST','/api/ingest','서버 토큰','실제 지표·로그 수신'],['POST','/api/incidents/:id/analysis','관리자·운영자','근거 분석 저장'],['PATCH','/api/incidents/:id','관리자·운영자','상태와 메모'],['GET','/api/incidents/:id/events','인증','처리 이력'],['GET','/api/incidents/:id/analysis','인증','분석 이력'],['GET','/api/manuals','인증','매뉴얼 목록'],['GET','/api/report','인증','전체 DB 집계'],['GET / POST','/api/users','관리자','계정 조회·생성'],['PATCH','/api/users/:id/role','관리자','역할 변경'],['GET','/api/audit','관리자','감사 이력']]
doc('요구사항명세서','요구사항 ID와 실제 API 및 수용 조건을 연결한다. 권한 검사와 입력 검증은 화면 숨김 여부에 의존하지 않고 서버에서 수행한다.',[
 section('인증과 접근 제어',['세션은 8시간 유효하며 쿠키는 HttpOnly 및 SameSite Strict를 사용한다. HTTPS 직접 연결 시 Secure를 부여한다. 리버스 프록시에서 TLS를 종료할 경우 프록시의 쿠키 정책도 운영자가 점검해야 한다.','IP별 로그인 시도는 1분에 15회로 제한한다. 역할은 admin, operator, viewer만 허용한다. 관리자는 자신의 역할을 직접 바꿀 수 없다. 비밀번호 변경과 역할 변경은 해당 사용자 세션 및 WebSocket을 폐기한다.','수용 조건은 비인증 조회 401, 권한 부족 변경 403, 타 Origin 변경 요청 403, 중복 서버 등록 409다. 초기 계정 비밀번호는 무작위 생성하고 공개 패키지에 넣지 않는다.']),
 section('수집과 장애 감지',['지표 본문은 cpu, ram, disk, network_rx, network_tx를 모두 포함하고 각 값은 유한 수치 또는 null이다. 사용률은 0에서 100, 네트워크는 0에서 10의 15제곱 이하 바이트/초다. 수신 JSON은 64KiB 이하이며 로그는 최대 100건·각 4000자다.','CPU 85%, RAM 90%, Disk 90% 이상을 감지한다. 97% 이상이면 critical, 그 미만은 warning이다. ERROR 로그는 LOG 장애로 분류한다. 활성 에이전트의 마지막 수신 또는 등록 후 60초가 경과하면 HEARTBEAT 장애를 생성한다.','같은 서버와 분류의 미해결 장애는 active_key 유일 제약으로 묶는다. 자동 해결은 하지 않으며 담당자가 처리 메모를 작성한다. 상태는 open → acknowledged → resolved 또는 open → resolved다. 해결 후 같은 조건이 다시 감지되면 새로운 장애로 기록한다.']),
 section('API 명세',table=(['메서드','경로','권한','주요 결과'],apirows[:10])),
 section('장애 및 운영 API',table=(['메서드','경로','권한','주요 결과'],apirows[10:])),
 section('AI 응답 및 실시간 화면 수용 조건',['매뉴얼은 한국어 어절 및 문자 bigram으로 토큰화하고 BM25 점수로 최대 3개를 검색한다. AI 활성화 시 Ollama 임베딩 cosine 순위와 BM25 순위를 RRF로 결합한다. 서로 다른 점수 척도를 직접 더하지 않는다.','모델 출력은 원인 가설, 확인 목록, 대응 목록, 문서 ID 배열의 JSON 스키마로 제한한다. 원인 후보와 확인·대응 항목은 매뉴얼의 구조화 근거에서만 선택하고 서버에서도 허용 집합을 다시 검증한다. 자료에 없는 조치와 인용 ID를 거부한다. 임베딩 실패는 BM25로, 생성 또는 계약 검증 실패는 원문 안내로 대체한다. 검색 근거가 없으면 답변을 보류한다.','WebSocket은 HTTP 세션 인증과 Origin 검사를 통과해야 한다. 화면은 실제·가상 서버 및 장애를 분리한다. 네트워크 최초 샘플이나 OS 미지원 값은 미수집으로 표시한다. 기록된 수치는 가상의 성능 지표로 치환하지 않는다.'])])

schedule=[['분석 및 범위 정의','2026-11-26','2026-11-26','완료','요구·권한·출처 정책'],['DB 및 인증 구현','2026-11-26','2026-11-26','완료','SQLite·RBAC·세션'],['지표 수집 및 장애 구현','2026-11-26','2026-11-26','완료','실제·가상·에이전트'],['대시보드 및 로그 구현','2026-11-26','2026-11-26','완료','WebSocket·시계열'],['RAG 및 AI 연동','2026-11-26','2026-11-26','완료','BM25·CPU 임베딩·스키마'],['자동 테스트 및 수정','2026-11-26','2026-11-26','완료','단위·API·통합'],['문서 및 발표자료 제작','2026-11-26','2026-11-26','진행','최종 렌더 검증'],['원격 저장소 및 ZIP','2026-11-26','2026-11-26','진행','권한 확인·동기화'],['MariaDB 및 Docker 실기동','추후','추후','후속','전용 서비스 환경 필요'],['현업 로그·부하·AI 품질 검증','추후','추후','후속','독립 평가 데이터 필요']]
if release.get('documents_complete'):schedule[6][3]='완료'
if release.get('delivery_complete'):schedule[7][3]='완료'
if release.get('mariadb','').startswith('MariaDB 11.4'):
    schedule[8]=['Docker MariaDB 내부 통합 검증','2026-11-26','2026-11-26','완료','내부 API 9개 · 호스트 포트 미확인']
    schedule[9][0]='현업 품질 및 Docker 호스트 접속';schedule[9][4]='독립 평가·포트·장기 부하 검증'
test_count=28
doc('개발일정표','실제 작업일은 2026년 11월 26일이다. 여러 주에 걸쳐 개발한 것처럼 기간을 만들지 않으며, 환경이 필요한 후속 검증은 완료 작업과 구분한다.',[
 section('작업 일정과 산출물',table=(['작업','시작','종료','상태','산출물 또는 조건'],schedule[:6])),
 section('제출 및 후속 일정',table=(['작업','시작','종료','상태','산출물 또는 조건'],schedule[6:])),
 section('선후 관계와 완료 기준',['인증·DB → 수집·장애 → API·화면 → 검색·생성 → 테스트 → 문서 증빙 → 원격 동기화 → ZIP 순서로 검증한다. 화면과 문서는 기능 테스트 증빙을 반영하며 변환 후 무결성과 잘림을 확인한다.','XLSX 일정표의 기간은 종료일에서 시작일을 뺀 값에 1을 더한 달력 일수다. 추후 작업은 날짜와 기간을 비워 두며 임의의 완료 예정일을 넣지 않는다.','동일 날짜 작업의 기간 합은 인일이나 총 소요 시간을 뜻하지 않는다. 실제 개발 소요 시간이나 일정 준수율을 측정한 자료로 사용하지 않는다.'])])

doc('프로젝트기획서','OpsMate는 단일 PC에서 재현할 수 있는 관제 데모를 우선 제공하고, 실제 원격 수집과 로컬 AI 연동을 확장 가능한 구조로 묶는 프로젝트다.',[
 section('프로젝트 목표',['서버 상태 확인에서 장애 탐지, 매뉴얼 검색, 담당자 처리 기록까지 하나의 흐름을 구현한다. 관리자·운영자·조회자의 업무 범위를 구분하고 변경 이력을 추적한다.','핵심 시연은 실제 실행 호스트 관제와 가상 디스크 장애를 함께 보여 주되 출처를 명확히 표시하는 것이다. 모델이 없거나 응답 검증에 실패해도 원문 매뉴얼로 운영자가 확인을 이어갈 수 있어야 한다.']),
 section('기술 구성과 선택 이유',table=(['계층','기술','선택 이유'],[['화면','HTML CSS JavaScript','별도 빌드 없이 실행·외부 CDN 불필요'],['서버','Node.js 24 HTTP·ws','API와 실시간 스트림 통합'],['저장소','SQLite / MariaDB 어댑터','간편한 데모와 DB 확장'],['AI','Ollama BM25 임베딩 RRF','로컬 모델과 근거 검색'],['운영','Docker GitHub Actions','재현 가능한 실행 및 자동 검사']])),
 section('시스템 구성',image='시스템아키텍처.png',paragraphs=['브라우저는 API와 인증 WebSocket을 사용한다. 에이전트는 서버별 토큰으로 지표와 로그를 푸시한다. AI 응답은 실행 경로와 연결하지 않으며 담당자가 승인한 조치를 시스템 밖에서 수행한다.']),
 section('범위 및 위험 관리',['실제 지표는 OS·권한에 따라 일부 수집하지 못할 수 있다. null과 수집 지연을 그대로 표시한다. 단일 샘플 감지는 오탐에 민감하므로 후속 운영 튜닝에서 지속시간과 히스테리시스를 도입한다.','AI는 근거 ID가 유효해도 잘못된 원인을 제시할 수 있다. 문서 검색 평가와 모델 응답 계약 평가를 분리하고 실제 현장 장애 정확도는 주장하지 않는다.','배포 환경, 방화벽, TLS, 백업 보존, 개인정보 로그 처리, 계정 복구 및 장시간 안정성은 운영 전 별도 검증해야 한다.'])])

conn=sqlite3.connect(ROOT/'fixtures/demo.sqlite'); conn.row_factory=sqlite3.Row
tables=[r[0]for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
descriptions={'users':'사용자와 역할','sessions':'만료 시각이 있는 로그인 세션','servers':'수집 서버와 출처','metrics':'서버별 시계열 지표','logs':'수집 로그와 가상 로그','incidents':'장애 및 현재 처리 상태','incident_events':'장애 처리 이벤트 이력','analyses':'근거 기반 분석 이력','audit':'관리 및 운영 감사 로그'}
fields={'id':'행 식별자','username':'로그인 계정명','password_hash':'salt:scrypt 해시','role':'admin operator viewer','token_hash':'SHA256 토큰 해시','user_id':'users 외래키','expires_at':'만료 epoch 밀리초','name':'서버 표시 이름','hostname':'호스트 식별 문자열','source':'local agent demo','enabled':'수집 활성 0 또는 1','created_at':'UTC ISO8601 생성 시각','server_id':'servers 외래키','cpu':'CPU 사용률 % 또는 null','ram':'RAM 사용률 % 또는 null','disk':'작업 볼륨 사용률 % 또는 null','network_rx':'수신 바이트/초 또는 null','network_tx':'송신 바이트/초 또는 null','sampled_at':'UTC 수집 시각','level':'INFO WARN ERROR','message':'로그 원문','category':'CPU MEMORY DISK LOG HEARTBEAT','severity':'warning 또는 critical','status':'open acknowledged resolved','title':'장애 제목','active_key':'미해결 서버:분류 유일키','opened_at':'UTC 최초 감지 시각','resolved_at':'UTC 해결 시각 또는 null','resolution':'최근 처리 메모','incident_id':'incidents 외래키','actor':'처리자 계정명 또는 system','note':'처리 메모','mode':'ollama source-only abstain','answer':'분석 또는 매뉴얼 본문','citations':'문서 ID·발췌 JSON','action':'감사 동작명','detail':'감사 상세 문자열'}
schema_sections=[]; schema_json={}
for table_name in tables:
    cols=[dict(r)for r in conn.execute(f'PRAGMA table_info({table_name})')]; schema_json[table_name]=cols
    rows=[[c['name'],c['type'],'PK' if c['pk'] else ('필수'if c['notnull'] else '선택'),fields.get(c['name'],'저장 필드')]for c in cols]
    schema_sections.append(section(table_name+' 테이블',paragraphs=[descriptions[table_name]],table=(['필드','SQLite 타입','제약','의미'],rows)))
conn.close(); (ROOT/'evidence/schema.json').write_text(json.dumps(schema_json,ensure_ascii=False,indent=2),'utf-8')
doc('데이터정의서','실제 생성된 SQLite PRAGMA table_info 결과를 기준으로 총 9개 테이블의 필드와 단위를 정의한다. API 계층은 사용률 범위, 출처, 상태 전이와 역할을 검증한다.',[
 section('공통 규칙',['id는 자동 증가 정수이며 시각은 UTC ISO8601 문자열로 저장한다. 세션 만료는 epoch 밀리초다. 출처는 local, agent, demo로 구분하며 지표와 로그·장애에 함께 저장한다.','사용률은 백분율, 네트워크는 바이트/초다. 미수집 값은 null이며 0은 측정된 0을 뜻한다. 서버 이름과 계정명은 UNIQUE, 미해결 장애 active_key도 UNIQUE다.','세션과 수집 토큰은 원문 대신 SHA256 해시를 저장한다. 사용자 비밀번호는 무작위 salt와 scrypt로 저장한다. audit.actor는 계정명 스냅샷으로 외래키가 아니다.']),
 *schema_sections,
 section('관계와 보존 정책',paragraphs=['users 1:N sessions, servers 1:N metrics·logs·incidents, incidents 1:N incident_events·analyses 관계다. 서버 물리 삭제 API는 없으며 비활성으로 보존한다. 해결한 장애의 active_key는 null로 바뀌어 재발을 새 행으로 저장한다.','지표와 로그는 7일 보존한다. 장애, 분석, 처리, 감사 이력은 자동 삭제하지 않는다. SQLite는 외래키와 WAL을 활성화한다. MariaDB 어댑터는 자동 증가 및 실수 타입을 변환하지만 DB 간 데이터 이관을 자동 수행하지 않는다.'])])

doc('순서도','수집부터 감지와 담당자 처리까지의 흐름을 설명한다. 모델 출력은 운영 제안이며 자동 실행 단계가 없다.',[
 section('전체 처리 흐름',image='순서도.png'),
 section('예외와 상태 전이',['수집 인증·범위·JSON 검사에 실패하면 요청을 거부한다. 로컬 수집 미지원 값은 null로 유지한다. 동일 서버·분류의 기존 미해결 장애가 있으면 신규 행을 만들지 않는다.','검색 결과가 없으면 답변을 보류한다. 임베딩 실패는 BM25로 진행하며 모델 통신·스키마·인용 검증 실패는 매뉴얼 원문 안내로 대체한다. 이 대체 응답을 모델 분석 성공으로 집계하지 않는다.','운영자는 접수된 장애를 확인하거나 직접 해결할 수 있다. 해결한 장애를 다시 접수 상태로 되돌리는 API는 없다. 재발 시 새로운 장애 ID와 처리 이력을 생성한다.']),
 section('시연 절차',['초기화 후 로그인한다. 실제 호스트 지표가 수집되고 데모 서버의 DISK 장애가 생성되는지 확인한다. 가상 배지를 확인한 뒤 장애 상세에서 원문 매뉴얼 안내를 연다.','AI를 활성화한 환경에서는 가설·확인 사항·승인 후 대응과 참고 문서를 함께 읽는다. 조치 내용은 담당자가 직접 검토하고, 실제 수행한 내용과 확인 결과만 메모에 기록한다.'])])

doc('테스트결과서','Node.js 24.22.3에서 단위·API·통합 및 모의 Ollama 계약 테스트를 실행했다. 실제 브라우저와 실제 로컬 모델의 증빙은 자동 테스트 결과와 구분한다.',[
 section('자동 테스트 결과',['최종 자동 검사 수와 실패 건수는 evidence/test-output.txt 원본을 기준으로 확인한다. 초기 SQL 바인딩 개수 오류는 수정 후 전체 재검증했다. 로컬 네트워크가 차단된 샌드박스 실행은 테스트 성공 근거로 사용하지 않았다.'],table=(['분류','검증 내용','증빙'],[['단위','해시·임계치 경계·중복·실제 수집·검색','test/unit.test.js'],['API·통합','인증·RBAC·수집·상태·감사·WS','test/api.test.js'],['AI 계약','정상·허위 인용·접속 실패 대체','test/ai.test.js'],['의존성','npm audit 런타임 취약점 0건','evidence/npm-audit.json']])),
 section('검색 및 모델 평가',[f"수동 작성한 질의 15개와 자체 매뉴얼 5개에서 BM25 Top1은 {evaluation['top1']*100:.0f}%, Recall@3은 {evaluation['recall_at_3']*100:.0f}%였다. 무관 질의 1개는 답변 보류를 확인했다. 동일 작성자의 소규모 질의이므로 독립 데이터나 실운영 정확도를 뜻하지 않는다.",f"실제 Ollama 평가 모델은 kanana2:3b와 embeddinggemma:latest다. 최종 3개 질의 중 모델 응답 계약을 통과한 수는 {live['model_answers']}/{live['total']}다. 임베딩은 CPU 실행으로 CUDA 호환 문제를 피했다. 모델 응답의 근거 포함 여부와 의미 타당성은 별개다.",'실제 모델 응답 원문과 개별 소요 시간은 evidence/ai-live-evaluation.json에 보존한다. 소요 시간은 3개 개별 호출 값이며 평균 서비스 성능, 처리량, 동시성 보장으로 해석하지 않는다. 모델 응답은 사람의 내용 검토가 필요하다.']),
 section('브라우저 검증',[f"Chrome headless에서 로그인·대시보드·장애 원문 분석·로그·계정 화면을 확인했다. 캡처는 {ui['screenshots']}개이고 pageerror는 {len(ui['page_errors'])}건이다. 390×844 화면에서 문서 전체 가로 넘침은 {ui['mobile_horizontal_overflow']}였다.",'자동 캡처는 기능 접근과 렌더 결과를 확인한 것으로 모든 브라우저·장애인 접근성·모든 화면 조합의 완전 검증을 뜻하지 않는다.'],image='../evidence/02_dashboard.png'),
 section('검증 한계와 후속 검사',['실제 장애 정답 데이터, 장시간 부하, 다중 인스턴스, 자동 복구, 원격 TLS 프록시, 대규모 로그 및 파일 로테이션 유실률은 측정하지 않았다.','전용 Docker 앱 내부 HTTP와 MariaDB 11.4에서 로그인·서버·수집·감지·분석 저장·해결·로그 검색·보고서·감사 9개 통합 검사를 통과했다. Windows 호스트의 Docker 공개 포트 접속은 확인하지 못했다. 내부 기능 검증을 외부 접속 및 운영 배포 완료로 표시하지 않는다.'])])

doc('포트폴리오','OpsMate는 실제 시스템 지표와 가상 장애를 구분한 관제 화면, 역할 기반 운영 절차, 매뉴얼 근거 검색과 로컬 AI 응답 검증을 구현한 프로젝트다. 이 자료는 구현 범위와 실행 증빙을 중심으로 구성한다.',[
 section('핵심 구현과 설계 결정',['별도 프런트엔드 빌드 없이 HTML·CSS·JavaScript로 화면을 구성하고 Node.js 24와 SQLite로 실행한다. 서버 등록 시 발급한 토큰은 실제 에이전트만 사용하며 DB에는 해시를 저장한다.','단일 샘플 임계치 감지를 출발점으로 삼고 active_key 유일 제약으로 중복 장애를 억제했다. 처리 상태와 메모는 별도 이벤트로 남겨 누가 언제 처리했는지 확인할 수 있다.','AI는 모델 존재 여부에 의존하지 않는 BM25 검색을 기본으로 하고 임베딩·생성·인용 검증을 단계적으로 적용한다. 생성 실패는 원문 안내로 표시한다.']),
 section('실제 실행 관제 화면',image='../evidence/02_dashboard.png',paragraphs=['실행 호스트는 실제 수집값, 데모 웹 서버는 가상 데이터다. 서버·장애 통계의 출처를 나누며 수집할 수 없는 네트워크 값은 0으로 만들지 않는다.']),
 section('장애 분석과 대응 기록',image='../evidence/07_ai_analysis.png',paragraphs=['격리된 가상 DISK 장애에 실제 Ollama 모델 분석을 요청한 화면이다. 원인 후보·확인 사항·승인 후 대응을 매뉴얼에 등록된 항목에서 선택하고 참고 문서를 표시한다. 서버 명령 실행 경로는 없다.']),
 section('검증 결과와 개선 방향',[f"Node.js 24 자동 테스트와 Chrome UI 검증을 수행했다. 자체 검색 질의 15개에서 Top1 {evaluation['top1']*100:.0f}%를 측정했지만 현업 검색 정확도로 일반화하지 않는다. 실제 모델 응답 계약 통과는 최종 평가 {live['model_answers']}/{live['total']}다.",'의존성 보안 점검 후 알려진 취약점이 없는 버전으로 갱신했다. Docker 앱 내부와 MariaDB 11.4의 통합 검사 9개를 통과했다. 후속 과제는 Windows Docker 호스트 접속, 지속시간 기반 감지, 에이전트 재전송 큐, 독립 장애 데이터 평가와 장시간 부하 검사다.','본 자료는 프로젝트 구현을 설명한다. 사용자 개인의 경력, 소속, 현업 성과, 팀 기여율 또는 저자 이름을 추정해 기재하지 않았다.'])])

doc('프로젝트결과보고서','OpsMate의 실행 가능한 로컬 관제 시스템, 자동 검증 및 한국어 제출물을 제작했다. 구현과 검증의 범위를 분리하고 추가 환경이 필요한 항목은 후속 작업으로 명시한다.',[
 section('구현 결과',table=(['영역','구현 내용','현재 범위'],[['보안','로그인·RBAC·계정·감사','단일 인스턴스'],['수집','실제 호스트·에이전트·가상 분리','OS 지원 범위'],['장애','임계치·로그·수집 중단·이력','운영자 수동 해결'],['AI','BM25·임베딩·구조화 응답·인용','근거 제안·실행 없음'],['화면','실시간 관제·로그·보고서','HTML CSS JavaScript'],['제출','문서·도식·발표·SQLite 데모','형식·렌더 검사 증빙']])),
 section('측정 및 검증 결과',[f"자동 검사 증빙은 test-output.txt, UI 검사 증빙은 ui-check.json에 보존한다. 검색 평가 Top1 및 Recall@3은 15개 자체 질의에서 각각 {evaluation['top1']*100:.0f}%, {evaluation['recall_at_3']*100:.0f}%였다. 실제 Ollama 최종 모델 응답 계약 통과는 {live['model_answers']}/{live['total']}다.",'초기 수집 SQL 오류를 수정했고 CUDA 임베딩 오류는 CPU 실행으로 해결했다. 알려진 의존성 취약점은 수정 버전으로 갱신했다. 모델 출력은 근거 ID 및 구조를 검증하지만 원인 가설의 정답 여부를 보장하지 않는다.']),
 section('배포 및 제출 상태',[f"원격 저장소 상태: {release.get('github','최종 검증 단계에서 별도 기록')}.",f"Docker 실기동: {release.get('docker','데몬이 실행되지 않아 미검증')}.",f"MariaDB 실기동: {release.get('mariadb','전용 서비스 연결 미구성으로 미검증')}.",'최종 ZIP과 Git에는 자격 증명, 실행 DB, .env, node_modules를 포함하지 않는다. 초기화 스크립트는 사용자 환경에서 새 비밀번호를 생성한다. 공개 데모 DB는 가상 지표만 포함하고 계정·토큰·세션은 비워 둔다.']),
 section('미완료 및 후속 검증',['독립 장애 데이터의 검색·원인 정확도, 대규모 동시 접속 및 장시간 안정성, 원격 TLS 프록시, 운영 백업 복구 훈련은 완료하지 않았다. Redis와 분산 세션, 원격 자동 복구는 구현 범위 밖이다.','Docker 앱과 MariaDB의 내부 통합 검사는 통과했지만 Windows 호스트 공개 포트 접속은 확인하지 못했다. 이 환경에서는 로컬 Node 실행으로 브라우저 관제를 검증했다.','실제 모델은 매뉴얼의 등록된 후보만 선택하지만 그 후보가 실제 장애의 원인인지 추가 확인해야 한다. 모델 계약 통과율을 AI 정확도로 표시하지 않는다.','에이전트는 단순 파일 tail 방식이므로 전송 실패·로테이션·UTF-8 경계에서 손실 가능성이 있다. 운영 전 재전송 큐와 로그 처리 검증을 보완해야 한다.'])])

def render_doc(name,data):
    """동일 원본으로 MD와 DOCX를 만들고 페이지별로 내용이 분리되게 합니다."""
    md=[f'# OpsMate {name}','',data['intro'],'']
    document=Document(); sec=document.sections[0];sec.page_width=Cm(21);sec.page_height=Cm(29.7);sec.top_margin=Cm(2);sec.bottom_margin=Cm(2);sec.left_margin=Cm(2);sec.right_margin=Cm(2)
    normal=document.styles['Normal'];normal.font.name='맑은 고딕';normal.font.size=Pt(10.5);normal.paragraph_format.space_after=Pt(9);normal.paragraph_format.line_spacing=1.25
    normal.element.rPr.rFonts.set(qn('w:eastAsia'),'맑은 고딕')
    for style in ['Title','Heading 1','Heading 2']:
        document.styles[style].font.name='맑은 고딕';document.styles[style].font.color.rgb=RGBColor.from_string('162B42' if style!='Title' else '000000');document.styles[style].element.rPr.rFonts.set(qn('w:eastAsia'),'맑은 고딕')
    document.styles['Title'].font.size=Pt(25);document.styles['Heading 1'].font.size=Pt(16)
    title=document.add_paragraph('OpsMate '+name,'Title')
    # Word의 사용자 스타일 상속으로 제목 밑줄이 나타나지 않게 테두리 없음 값을 명시합니다.
    for owner in [title._p,document.styles['Title'].element,document.styles['Subtitle'].element]:
        pr=owner.get_or_add_pPr()
        for old in list(pr.findall(qn('w:pBdr'))):pr.remove(old)
        borders=OxmlElement('w:pBdr')
        for edge in ['top','left','bottom','right','between']:
            item=OxmlElement('w:'+edge);item.set(qn('w:val'),'nil');borders.append(item)
        pr.append(borders)
    subtitle=document.add_paragraph('2026년 11월 26일  |  버전 1.0',style='Subtitle')
    for run in subtitle.runs:run.font.size=Pt(10);run.font.italic=False;run.font.color.rgb=RGBColor.from_string('63758A')
    document.add_paragraph(data['intro'])
    for index,s in enumerate(data['sections']):
        # 두 짧은 절을 한 페이지에 묶고 도식·표가 큰 절은 독립 페이지로 둡니다.
        heading=document.add_heading(s['title'],level=1)
        if index>0 and (s.get('image') or s.get('table') or index%2==0 or len(data['sections'])>7):heading.paragraph_format.page_break_before=True
        md.extend(['## '+s['title'],''])
        for p in s['paragraphs']:document.add_paragraph(p);md.extend([p,''])
        if s.get('table'):
            heads,rows=s['table'];table=document.add_table(rows=1,cols=len(heads));table.style='Light Shading Accent 1';table.autofit=False
            # 문서의 17cm 본문 폭 안에서 API 경로 칸에 넓은 폭을 배정합니다.
            widths=([2,8,2.7,4.3]if heads[0]=='メソッド' else [17/len(heads)]*len(heads))
            if heads[0]=='메서드':widths=[2,7,3,5]
            for cell,head,w in zip(table.rows[0].cells,heads,widths):cell.text=head;cell.width=Cm(w)
            header=table.rows[0]._tr.get_or_add_trPr();repeat=OxmlElement('w:tblHeader');header.append(repeat)
            for row in rows:
                cells=table.add_row().cells
                for cell,val,w in zip(cells,row,widths):
                    cell.width=Cm(w);cell.text=str(val)
                    for p in cell.paragraphs:
                        p.paragraph_format.space_after=Pt(5);p.paragraph_format.space_before=Pt(5)
                        for run in p.runs:run.font.size=Pt(8.5)
            md+=['| '+' | '.join(heads)+' |','| '+' | '.join(['---']*len(heads))+' |']+['| '+' | '.join(map(str,r))+' |'for r in rows]+['']
        if s.get('image'):
            image_path=OUT/s['image'];document.add_picture(str(image_path),width=Cm(17));md.extend([f"![{s['title']}]({s['image']})",''])
    document.core_properties.title='OpsMate '+name;document.core_properties.author='';document.core_properties.subject='IT 인프라 관제 프로젝트 제출 문서'
    document.save(OUT/f'{name}.docx');(OUT/f'{name}.md').write_text('\n'.join(md),'utf-8')
for name,data in docs.items():render_doc(name,data)
(ROOT/'tools/doc-content.json').write_text(json.dumps(docs,ensure_ascii=False,indent=2),'utf-8')
(ROOT/'tools/schedule.json').write_text(json.dumps(schedule,ensure_ascii=False,indent=2),'utf-8')
print('한국어 MD 및 DOCX 생성',len(docs),'종, 도식 3종')
