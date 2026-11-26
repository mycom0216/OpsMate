/** 실제 수신 데이터와 복사 가능한 API 예시를 표시합니다. 코드를 평가하거나 실행하지 않습니다. */
const byId = (id) => document.getElementById(id);
let latest = null;
let activeTab = 'snapshot';
let currentCode = '';
let received = 0;
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

export function initializeDeveloperWorkbench({ refresh, onError }) {
  paintCode(byId('loginCode'), agentCode);
  renderEditor();
  const tabs = [...document.querySelectorAll('[data-code-tab]')];
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
  byId('clearDeveloperTrace').onclick = () => {
    byId('developerTrace').replaceChildren();
  };
}
