/**
 * 실제 API 응답과 복사 가능한 연동 코드를 표시하는 읽기 전용 개발자 작업 공간입니다.
 * snapshot 탭은 실제 응답, request/agent 탭은 사용자가 참고할 예시 문자열입니다.
 * 표시 코드 자체는 평가/실행하지 않으며 GET 확인 버튼만 앱의 기존 refresh를 호출합니다.
 * 이벤트 스트림은 이 브라우저가 받은 메시지 기록으로 OS/서버 로그 원문과는 다릅니다.
 */
/**
 * 코드 패널 전용 id 조회 도우미입니다. 실제 DOM 요소는 index.html에 정의되어 있습니다.
 */
const byId = (id) => document.getElementById(id);
/**
 * 마지막 수신 데이터와 선택 탭을 탭 내부 메모리에만 보관합니다. localStorage에 인증 정보는 쓰지 않습니다.
 */
let latest = null;
let activeTab = 'snapshot';
let currentCode = '';
let received = 0;
/**
 * 사용자가 프로젝트 루트에서 참고할 수 있는 에이전트 연동 예시 문자열입니다.
 * 환경변수 이름을 보여 줄 뿐 실제 AGENT_TOKEN이나 사용자의 토큰을 문자열에 삽입하지 않습니다.
 */
const agentCode = `import { createCollector } from './src/telemetry.js';

const collect = createCollector();
const sample = await collect();

await fetch(new URL('/api/ingest', process.env.OPSMATE_URL), {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: \`Bearer \${process.env.AGENT_TOKEN}\`,
  },
  body: JSON.stringify({ ...sample, logs: [] }),
});`;
/**
 * 로그인한 같은 출처의 브라우저에서 복사해 사용할 수 있는 GET 요청 예시입니다.
 * HttpOnly 쿠키를 읽어 표시하지 않고 브라우저가 자동으로 인증 쿠키를 보내게 합니다.
 */
const requestCode = `// 로그인한 브라우저에서 사용하는 읽기 전용 요청
const response = await fetch('/api/snapshot', {
  method: 'GET',
  credentials: 'same-origin',
});

if (!response.ok) {
  throw new Error(\`HTTP \${response.status}\`);
}

const { servers, incidents } = await response.json();
console.table(servers);
console.log('장애 수:', incidents.length);`;

/** 어휘 토큰마다 텍스트 노드를 만들어 HTML 및 스크립트 삽입을 방지합니다. */
/**
 * 문자열을 줄 번호와 구문 강조 span으로 나눠 표시합니다.
 * 토큰은 모두 textContent로 넣으므로 로그/서버명에 HTML이 있어도 실행되지 않습니다.
 * @param {HTMLElement} target 코드 줄을 넣을 패널
 * @param {string} code 표시 문자열. 평가하거나 동적으로 import하지 않습니다.
 */
function paintCode(target, code) {
  target.replaceChildren();
  const pattern =
    /(\/\/.*$|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\b(?:import|from|const|await|new|if|throw|return)\b|\b(?:true|false|null)\b|\b\d+(?:\.\d+)?\b)/g;
  for (const [index, line] of code.split('\n').entries()) {
    const row = document.createElement('div');
    row.className = 'code-line';
    const number = document.createElement('span');
    number.className = 'line-number';
    number.textContent = String(index + 1).padStart(2, '0');
    number.setAttribute('aria-hidden', 'true');
    const content = document.createElement('code');
    let offset = 0;
    for (const match of line.matchAll(pattern)) {
      content.append(document.createTextNode(line.slice(offset, match.index)));
      const token = document.createElement('span');
      const value = match[0];
      token.className = value.startsWith('//')
        ? 'syntax-comment'
        : /^["'`]/.test(value)
          ? 'syntax-string'
          : /^\d/.test(value) || /^(true|false|null)$/.test(value)
            ? 'syntax-number'
            : 'syntax-keyword';
      token.textContent = value;
      content.append(token);
      offset = match.index + value.length;
    }
    content.append(document.createTextNode(line.slice(offset) || (line ? '' : ' ')));
    row.append(number, content);
    target.append(row);
  }
}

/**
 * 현재 선택 탭의 문자열과 설명을 함께 갱신합니다.
 * JSON 탭은 전체 응답 중 첫 서버 객체를 보여 주며, 수신 전에는 대기 메시지를 표시합니다.
 */
function renderEditor() {
  currentCode =
    activeTab === 'request'
      ? requestCode
      : activeTab === 'agent'
        ? agentCode
        : JSON.stringify(latest?.servers?.[0] || { message: '실제 API 응답 수신 대기' }, null, 2);
  paintCode(byId('developerCode'), currentCode);
  byId('codeCaption').textContent =
    activeTab === 'snapshot'
      ? 'snapshot.servers[0] · 실제 API 응답'
      : activeTab === 'request'
        ? '동일 출처 세션 인증 · 읽기 전용 GET'
        : '환경변수 인증 · 에이전트 연동 예시';
}

/**
 * 실제 HTTP/WS 수신 시 앱에서 호출하여 JSON 탭과 터미널에 같은 관측값을 전달합니다.
 * 한 줄에 수신 시각·전송 방식·경로·출처별 서버 수를 기록하고 최근 24줄만 유지합니다.
 * @param {Object} data 실제 관제 스냅샷
 * @param {string} transport HTTP 또는 WS. 가짜 수신 이벤트를 생성하는 타이머는 없습니다.
 */
export function updateDeveloperWorkbench(data, transport) {
  latest = data;
  if (activeTab === 'snapshot') renderEditor();
  const trace = byId('developerTrace');
  const row = document.createElement('div');
  row.className = 'trace-line';
  const entries = [
    ['trace-time', new Date().toLocaleTimeString('en-GB', { hour12: false })],
    ['trace-method', transport],
    ['trace-route', transport === 'WS' ? '/ws → snapshot' : 'GET /api/snapshot'],
    [
      'trace-message',
      `서버 ${data.servers.length} · 실제 ${data.servers.filter((s) => s.source !== 'demo').length} / 가상 ${data.servers.filter((s) => s.source === 'demo').length} · 수신 #${++received}`,
    ],
  ];
  for (const [className, text] of entries) {
    const item = document.createElement('span');
    item.className = className;
    item.textContent = text;
    row.append(item);
  }
  trace.append(row);
  while (trace.children.length > 24) trace.firstElementChild.remove();
  trace.scrollTop = trace.scrollHeight;
}

/**
 * 탭·키보드 탐색·복사·GET 확인·기록 비우기 이벤트를 한 번 연결합니다.
 * @param {Object} handlers refresh는 읽기 전용 조회, onError는 화면 오류 안내 함수입니다.
 */
export function initializeDeveloperWorkbench({ refresh, onError }) {
  paintCode(byId('loginCode'), agentCode);
  renderEditor();
  const tabs = [...document.querySelectorAll('[data-code-tab]')];
  /**
   * 선택 상태와 tabindex를 함께 바꿔 마우스뿐 아니라 방향키로도 탭을 이동할 수 있게 합니다.
   */
  function selectTab(tab) {
    activeTab = tab.dataset.codeTab;
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
    }
    renderEditor();
  }
  tabs.forEach((tab, index) => {
    tab.onclick = () => selectTab(tab);
    tab.onkeydown = (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabs.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      selectTab(tabs[next]);
      tabs[next].focus();
    };
  });
  selectTab(tabs[0]);
  /**
   * 화면에 보이는 코드의 원문만 복사합니다. 줄 번호와 구문 강조용 DOM은 포함하지 않습니다.
   * 클립보드 권한이나 브라우저 환경 때문에 실패하면 자동 재시도 대신 안내를 표시합니다.
   */
  byId('copyDeveloperCode').onclick = async () => {
    try {
      await navigator.clipboard.writeText(currentCode);
      byId('copyDeveloperCode').textContent = '복사됨';
      setTimeout(() => {
        byId('copyDeveloperCode').textContent = '복사';
      }, 1600);
    } catch {
      onError('클립보드에 접근할 수 없습니다. 코드 영역을 선택해 복사하십시오.');
    }
  };
  /**
   * 표시 중인 코드가 아니라 주입받은 읽기 전용 refresh만 호출합니다.
   * agent 탭을 보고 있어도 POST 수집이나 서버 명령을 실행하지 않습니다.
   */
  byId('runSnapshotRequest').onclick = async () => {
    const button = byId('runSnapshotRequest');
    button.disabled = true;
    try {
      await refresh();
    } catch (error) {
      onError(error.message);
    } finally {
      button.disabled = false;
    }
  };
  /**
   * 현재 브라우저에 쌓인 표시 행만 지웁니다. DB 감사 기록·장애·서버 로그는 삭제하지 않습니다.
   */
  byId('clearDeveloperTrace').onclick = () => {
    byId('developerTrace').replaceChildren();
  };
}
