/**
 * 브라우저 관제 화면의 상태, HTTP API, WebSocket과 사용자 이벤트를 연결합니다.
 * 화면 흐름: enter → refresh/renderSnapshot → connect → 필요한 화면의 별도 조회.
 * 응답 문자열은 textContent로 표시하고, 화면에서 버튼을 숨기는 것과 별개로 서버도 RBAC를 검사합니다.
 * 개발자 코드 패널은 developer.js가 담당하며 수신 스냅샷만 전달합니다.
 */
import { initializeDeveloperWorkbench, updateDeveloperWorkbench } from './developer.js';
/** API 응답은 textContent/텍스트 노드로만 표시하여 저장된 로그의 HTML 실행을 막습니다. */
/**
 * 반복해서 쓰는 id 기반 DOM 조회를 짧게 표현하는 도우미입니다.
 */
const $ = (id) => document.getElementById(id);
/**
 * 이 탭의 로그인 사용자·최신 스냅샷·연결·선택 화면을 보관합니다. DB의 원본 상태를 대신하지 않습니다.
 */
let user = null,
  snapshot = null,
  ws = null,
  selectedIncident = null,
  report = null,
  currentTab = 'dashboard',
  refreshTimer = null;
const titles = {
  dashboard: '통합 대시보드',
  incidents: '장애 대응',
  logs: '로그 탐색',
  servers: '서버 관리',
  manuals: '운영 매뉴얼',
  report: '운영 보고서',
  admin: '계정 및 감사',
};
/**
 * 저장된 출처 코드를 화면의 실제 호스트/실제 에이전트/가상 데모 라벨로 바꿉니다.
 */
const source = (s) =>
  s === 'demo' ? '가상 데모' : s === 'local' ? '실제 호스트' : '실제 에이전트';
/**
 * 장애 상태 코드를 사용자가 읽는 접수/확인/해결 라벨로 바꿉니다.
 */
const status = (s) => ({ open: '접수', acknowledged: '확인', resolved: '해결' })[s] || s;
/**
 * DB의 UTC 시각을 브라우저의 현지 시각으로 보여 줍니다. 값이 없으면 미수집으로 표시합니다.
 */
const stamp = (s) => (s ? new Date(s).toLocaleString('ko-KR') : '미수집');
/**
 * 측정된 0%와 미수집 null을 구분하고, 수치는 소수점 한 자리로 표시합니다.
 */
const pct = (v) => (v == null ? '미수집' : `${Number(v).toFixed(1)}%`);
/**
 * DOM 요소를 만들고 텍스트를 안전하게 넣는 공통 도우미입니다.
 * 서버명·로그·AI 답변 등을 innerHTML로 넣지 않아 문자열이 HTML로 실행되지 않게 합니다.
 */
const el = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
/**
 * 페이지 상단에 작업 결과 또는 오류를 텍스트로 표시합니다.
 */
function notice(message) {
  $('notice').textContent = message;
  $('notice').hidden = false;
}
/**
 * 같은 출처의 /api 경로에 JSON 요청을 보내고 비정상 HTTP 응답을 예외로 바꿉니다.
 * 401이면 기존 로그인 화면 상태와 연결 재시도 타이머를 정리해 로그인을 다시 받습니다.
 * @param {string} path /snapshot 등 /api 뒤의 경로
 * @param {Object} options fetch 메서드·헤더·본문 옵션
 * @returns {Promise<Object|Array>} 파싱된 API 응답
 */
async function api(path, options = {}) {
  const res = await fetch('/api' + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const data = await res.json();
  if (!res.ok) {
    if (res.status === 401 && user) {
      user = null;
      ws?.close();
      clearTimeout(refreshTimer);
      $('console').hidden = true;
      $('loginView').hidden = false;
    }
    throw new Error(data.error || '요청 실패');
  }
  return data;
}
/**
 * POST 요청의 본문을 JSON으로 직렬화해 api에 전달합니다. 인증 쿠키는 브라우저가 관리합니다.
 */
const post = (path, data = {}) => api(path, { method: 'POST', body: JSON.stringify(data) });
/**
 * 출처나 상태를 나타내는 텍스트 배지를 만듭니다. 색은 CSS의 상태 클래스로 결정합니다.
 */
function pill(text, kind = '') {
  return el('span', text, `pill ${kind}`);
}
/**
 * 헤더와 행 배열을 표로 그립니다. DOM 요소는 그대로, 일반 값은 텍스트 노드로 넣습니다.
 * 행이 없으면 빈 표 대신 안내 행을 만들어 수집 대기와 렌더 오류를 구분할 수 있게 합니다.
 */
function table(target, headers, rows) {
  const wrap = el('div', undefined, 'table-wrap'),
    t = el('table'),
    head = el('thead'),
    tr = el('tr');
  headers.forEach((h) => tr.append(el('th', h)));
  head.append(tr);
  t.append(head);
  const body = el('tbody');
  for (const row of rows) {
    const r = el('tr');
    row.forEach((v) => {
      const c = el('td');
      c.append(v instanceof Node ? v : document.createTextNode(String(v ?? '')));
      r.append(c);
    });
    body.append(r);
  }
  if (!rows.length) {
    const r = el('tr'),
      c = el('td', '표시할 데이터가 없습니다.');
    c.colSpan = headers.length;
    r.append(c);
    body.append(r);
  }
  t.append(body);
  wrap.append(t);
  target.replaceChildren(wrap);
}
/**
 * 비동기 작업 버튼을 만들고 실행 중에는 중복 클릭을 막습니다.
 * 오류는 공통 안내에 표시하며 finally에서 성공 여부와 관계없이 버튼을 다시 활성화합니다.
 */
function action(label, fn, cls = '') {
  const b = el('button', label, cls);
  b.onclick = async () => {
    b.disabled = true;
    try {
      await fn();
    } catch (e) {
      notice(e.message);
    } finally {
      b.disabled = false;
    }
  };
  return b;
}
/**
 * 장애 객체를 공통 표의 열 배열로 바꾸고 상세 조회 버튼에 해당 장애 ID를 연결합니다.
 */
function incidentRows(items) {
  return items.map((i) => [
    el('span', '#' + String(i.id).padStart(3, '0'), 'incident-id'),
    i.server_name,
    pill(source(i.source), i.source === 'demo' ? 'demo' : ''),
    el('span', i.category, 'category-tag'),
    pill(status(i.status), i.status === 'open' ? 'error' : ''),
    el('span', i.title, 'incident-title'),
    action('상세 보기 →', () => showIncident(i.id), 'subtle'),
  ]);
}
// 고정된 SVG 아이콘은 외부 이미지나 폰트 의존성 없이 상태 정보를 보조합니다.
/**
 * 정해 둔 SVG 경로만 사용해 아이콘을 그립니다. 사용자 문자열을 SVG 마크업으로 해석하지 않습니다.
 */
function icon(name) {
  const paths = {
    dashboard: ['M3 3h7v7H3z', 'M14 3h7v7h-7z', 'M3 14h7v7H3z', 'M14 14h7v7h-7z'],
    incidents: ['M12 3 2 21h20L12 3Z', 'M12 9v5', 'M12 17h.01'],
    logs: ['M4 5h16', 'M4 10h10', 'M4 15h16', 'M4 20h10'],
    servers: [
      'M4 3h16v7H4z',
      'M4 14h16v7H4z',
      'M7 6.5h.01',
      'M7 17.5h.01',
      'M11 6.5h6',
      'M11 17.5h6',
    ],
    manuals: [
      'M3 4h7l2 2 2-2h7v16h-7l-2 1-2-1H3Z',
      'M12 6v15',
      'M6 9h3',
      'M15 9h3',
      'M6 13h3',
      'M15 13h3',
    ],
    report: ['M4 3v18h17', 'M8 16v-5', 'M13 16V7', 'M18 16V4'],
    admin: ['M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6Z', 'm8 12 3 3 5-6'],
    refresh: ['M20 7v5h-5', 'M4 17v-5h5', 'M6 7a7 7 0 0 1 12-1l2 6', 'M18 17a7 7 0 0 1-12 1l-2-6'],
    demo: ['m12 3 9 5v9l-9 5-9-5V8Z', 'm3 8 9 5 9-5', 'M12 13v9'],
  };
  const n = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  n.setAttribute('viewBox', '0 0 24 24');
  n.setAttribute('fill', 'none');
  n.setAttribute('stroke', 'currentColor');
  n.setAttribute('stroke-width', '1.5');
  n.setAttribute('stroke-linecap', 'round');
  n.setAttribute('stroke-linejoin', 'round');
  n.setAttribute('aria-hidden', 'true');
  for (const d of paths[name] || paths.servers) {
    const path = document.createElementNS(n.namespaceURI, 'path');
    path.setAttribute('d', d);
    n.append(path);
  }
  return n;
}
/**
 * 한 번 받은 스냅샷으로 통계·서버 카드·장애 표·차트 선택값을 함께 갱신합니다.
 * 실제/가상 건수는 source로 나누며 비활성 서버도 등록 목록에는 남겨 표시합니다.
 * @param {Object} data /api/snapshot 또는 WebSocket snapshot의 본문
 * @param {string} transport HTTP 또는 WS. 개발자 이벤트 스트림의 실제 수신 구분입니다.
 */
function renderSnapshot(data, transport = 'HTTP') {
  snapshot = data;
  updateDeveloperWorkbench(data, transport);
  const actual = data.servers.filter((s) => s.source !== 'demo'),
    demo = data.servers.filter((s) => s.source === 'demo'),
    active = data.incidents.filter((i) => i.status !== 'resolved');
  const cards = [
    ['실제 모니터링 서버', actual.length, '대', '실제 호스트 및 연결 에이전트', 'servers'],
    ['가상 데모 서버', demo.length, '대', '시연용 데이터 · 실제 지표 제외', 'demo'],
    [
      '미해결 실제 장애',
      active.filter((i) => i.source !== 'demo').length,
      '건',
      '담당자 확인 및 조치 필요',
      'incidents',
    ],
    [
      '미해결 가상 장애',
      active.filter((i) => i.source === 'demo').length,
      '건',
      '가상 시나리오에서 감지',
      'incidents',
    ],
  ];
  $('summary').replaceChildren(
    ...cards.map(([title, value, unit, note, symbol]) => {
      const d = el('div', undefined, 'stat'),
        top = el('div', undefined, 'stat-top'),
        badge = el('span', undefined, 'stat-icon');
      badge.append(icon(symbol));
      top.append(el('small', title), badge);
      const number = el('strong', String(value));
      number.append(el('em', unit));
      const foot = el('p');
      foot.append(el('span'), document.createTextNode(note));
      d.append(top, number, foot);
      return d;
    }),
  );
  $('updatedAt').textContent =
    '마지막 수집 · ' + new Date(data.at).toLocaleTimeString('ko-KR', { hour12: false });
  $('fleetCount').textContent = data.servers.length;
  $('serverCards').replaceChildren(
    ...data.servers.map((s) => {
      const card = el('div', undefined, 'server-card'),
        stale = !s.sampled_at || Date.now() - Date.parse(s.sampled_at) > 60000,
        top = el('div', undefined, 'server-card-top'),
        heading = el('div', undefined, 'server-heading'),
        serverIcon = el('span', undefined, 'server-icon');
      serverIcon.append(icon(s.source === 'demo' ? 'demo' : 'servers'));
      const identity = el('div');
      identity.append(el('h3', s.name), el('small', s.hostname, 'hostname'));
      heading.append(serverIcon, identity);
      top.append(heading, pill(source(s.source), s.source === 'demo' ? 'demo' : ''));
      card.append(top);
      const meters = el('div', undefined, 'meters');
      for (const [key, label] of [
        ['cpu', 'CPU'],
        ['ram', 'MEMORY'],
        ['disk', 'DISK'],
      ]) {
        const d = el('div'),
          track = el('div', undefined, 'meter-track'),
          fill = el(
            'i',
            undefined,
            'meter-fill ' + key + (s[key] >= 97 ? ' critical' : s[key] >= 85 ? ' warning' : ''),
          );
        fill.style.width = (s[key] == null ? 0 : Math.max(0, Math.min(100, s[key]))) + '%';
        track.append(fill);
        d.append(el('small', label), el('b', pct(s[key])), track);
        meters.append(d);
      }
      const foot = el('div', undefined, 'server-card-footer'),
        net = el('div', undefined, 'net');
      const speed = (v) =>
        v == null
          ? '—'
          : v >= 1048576
            ? (v / 1048576).toFixed(1) + ' MB/s'
            : v >= 1024
              ? (v / 1024).toFixed(1) + ' KB/s'
              : Math.round(v) + ' B/s';
      net.append(
        el('span', '↓ ' + speed(s.network_rx), 'rx'),
        document.createTextNode('   '),
        el('span', '↑ ' + speed(s.network_tx), 'tx'),
      );
      foot.append(
        net,
        el(
          'span',
          !s.enabled ? 'PAUSED' : stale ? 'WAITING' : 'LIVE',
          'server-status' + (!s.enabled || stale ? ' idle' : ''),
        ),
      );
      card.append(meters, foot);
      return card;
    }),
  );
  const max = Math.max(
    1,
    ...['CPU', 'MEMORY', 'DISK', 'LOG', 'HEARTBEAT'].map(
      (c) => data.incidents.filter((i) => i.category === c).length,
    ),
  );
  $('incidentCount').textContent = data.incidents.length + '건';
  $('categories').replaceChildren(
    ...['CPU', 'MEMORY', 'DISK', 'LOG', 'HEARTBEAT'].map((c) => {
      const items = data.incidents.filter((i) => i.category === c),
        real = items.filter((i) => i.source !== 'demo').length,
        virtual = items.length - real,
        d = el('div', undefined, 'category'),
        row = el('div'),
        counts = el('span', undefined, 'category-counts');
      counts.append(
        document.createTextNode('실제 '),
        el('b', real),
        document.createTextNode('  /  가상 '),
        el('b', virtual),
      );
      row.append(el('span', c), counts);
      const bar = el('div', undefined, 'bar');
      for (const [value, cls] of [
        [real, ''],
        [virtual, 'demo-fill'],
      ]) {
        const fill = el('i', undefined, cls);
        fill.style.width = (value / max) * 100 + '%';
        bar.append(fill);
      }
      d.append(row, bar);
      return d;
    }),
  );
  table(
    $('recentIncidents'),
    ['ID', '서버', '데이터 출처', '분류', '상태', '감지 내용', ''],
    incidentRows(data.incidents.slice(0, 5)),
  );
  table(
    $('incidentTable'),
    ['ID', '서버', '데이터 출처', '분류', '상태', '감지 내용', ''],
    incidentRows(data.incidents),
  );
  table(
    $('serverTable'),
    ['서버', '호스트', '출처', '수집 시각', '관리'],
    data.servers.map((s) => [
      s.name,
      s.hostname,
      source(s.source),
      stamp(s.sampled_at),
      user.role === 'admin'
        ? action(
            s.enabled ? '수집 중지' : '수집 재개',
            async () => {
              await api(`/servers/${s.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ enabled: s.enabled ? 0 : 1 }),
              });
              await refresh();
            },
            'subtle',
          )
        : s.enabled
          ? '활성'
          : '비활성',
    ]),
  );
  const selected = $('chartServer').value;
  $('chartServer').replaceChildren(
    ...data.servers.map((s) => {
      const o = el('option', `${s.name} · ${source(s.source)}`);
      o.value = s.id;
      return o;
    }),
  );
  if (data.servers.some((s) => String(s.id) === selected)) $('chartServer').value = selected;
  void drawChart().catch((e) => notice(e.message));
}
/**
 * 선택한 서버의 최신 120개 지표를 받아 SVG 차트와 포인터 툴팁을 그립니다.
 * 표시 폭은 달라도 viewBox 좌표로 변환해 같은 샘플을 가리키게 합니다.
 * 미수집 구간은 선을 끊고, 샘플 한 개는 점으로 표시해 없는 추세를 만들지 않습니다.
 */
async function drawChart() {
  if (!$('chartServer').value) return;
  const selected = $('chartServer').value,
    rows = await api('/metrics?serverId=' + selected);
  /**
   * 응답이 오는 동안 사용자가 다른 서버를 골랐다면 오래된 요청으로 새 선택을 덮지 않습니다.
   */
  if ($('chartServer').value !== selected) return;
  const svg = $('chart'),
    ns = 'http://www.w3.org/2000/svg';
  svg.replaceChildren();
  const make = (tag, attrs = {}) => {
    const n = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  const defs = make('defs');
  for (const [key, color] of [
    ['cpu', '#51ddc5'],
    ['ram', '#9b8bff'],
  ]) {
    const gradient = make('linearGradient', {
      id: key + 'Area',
      x1: '0',
      y1: '0',
      x2: '0',
      y2: '1',
    });
    gradient.append(
      make('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': '.16' }),
      make('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': '0' }),
    );
    defs.append(gradient);
  }
  svg.append(defs);
  for (const value of [0, 25, 50, 75, 100]) {
    const y = 205 - value * 1.8;
    svg.append(
      make('line', {
        x1: 35,
        x2: 750,
        y1: y,
        y2: y,
        stroke: '#263248',
        'stroke-dasharray': '3 6',
        'stroke-width': '.7',
      }),
    );
    const label = make('text', { x: 1, y: y + 3 });
    label.textContent = value + '%';
    svg.append(label);
  }
  for (const [key, color] of [
    ['ram', '#9b8bff'],
    ['cpu', '#51ddc5'],
  ]) {
    let segment = [];
    /**
     * 연속해서 측정된 한 구간만 채우고 선을 그립니다. null을 만날 때 구간을 끝내는 데 사용합니다.
     */
    const paint = () => {
      if (!segment.length) return;
      const pts = segment.map((p) => p.join(',')).join(' ');
      if (segment.length > 1) {
        svg.append(
          make('polygon', {
            points: `${segment[0][0]},205 ${pts} ${segment.at(-1)[0]},205`,
            fill: `url(#${key}Area)`,
          }),
        );
        svg.append(
          make('polyline', {
            points: pts,
            fill: 'none',
            stroke: color,
            'stroke-width': '2.2',
            'stroke-linejoin': 'round',
            'stroke-linecap': 'round',
          }),
        );
      } else
        svg.append(make('circle', { cx: segment[0][0], cy: segment[0][1], r: 3, fill: color }));
      segment = [];
    };
    rows.forEach((r, i) => {
      if (r[key] == null) {
        paint();
        return;
      }
      segment.push([35 + (i / Math.max(1, rows.length - 1)) * 715, 205 - r[key] * 1.8]);
    });
    paint();
  }
  const time = (s) =>
    new Date(s).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' });
  if (rows.length)
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      const i = Math.round(f * (rows.length - 1)),
        label = make('text', {
          x: 35 + f * 715,
          y: 225,
          'text-anchor': f === 0 ? 'start' : f === 1 ? 'end' : 'middle',
        });
      label.textContent = time(rows[i].sampled_at);
      svg.append(label);
    }
  $('latestCpu').textContent = rows.length ? pct(rows.at(-1).cpu) : '—';
  $('latestRam').textContent = rows.length ? pct(rows.at(-1).ram) : '—';
  $('chartNote').textContent = rows.length
    ? `${rows.length} samples  /  ${source(snapshot.servers.find((s) => String(s.id) === selected)?.source)}  /  CPU · RAM 사용률`
    : '수집 대기 중 · 첫 지표를 수신하면 추이를 표시합니다.';
  const guide = make('line', {
    x1: 35,
    x2: 35,
    y1: 20,
    y2: 205,
    stroke: '#57708e',
    'stroke-dasharray': '3 3',
    visibility: 'hidden',
  });
  svg.append(guide);
  const tooltip = $('chartTooltip');
  /**
   * 실제 화면의 포인터 위치를 760폭의 차트 좌표로 변환한 뒤 가장 가까운 샘플을 선택합니다.
   * 양끝 범위를 제한하고 툴팁이 패널 바깥으로 밀려나지 않게 위치를 보정합니다.
   */
  svg.onpointermove = (e) => {
    if (!rows.length) return;
    const rect = svg.getBoundingClientRect(),
      ratio = (e.clientX - rect.left) / rect.width,
      index = Math.max(
        0,
        Math.min(rows.length - 1, Math.round(((ratio * 760 - 35) / 715) * (rows.length - 1))),
      ),
      sample = rows[index],
      x = 35 + (index / Math.max(1, rows.length - 1)) * 715;
    guide.setAttribute('x1', x);
    guide.setAttribute('x2', x);
    guide.setAttribute('visibility', 'visible');
    tooltip.textContent = `${new Date(sample.sampled_at).toLocaleTimeString('ko-KR', { hour12: false })}\nCPU  ${pct(sample.cpu)}\nRAM  ${pct(sample.ram)}`;
    tooltip.style.left = Math.min(Math.max(8, e.clientX - rect.left + 12), rect.width - 145) + 'px';
    tooltip.style.top = '18px';
    tooltip.hidden = false;
  };
  svg.onpointerleave = () => {
    tooltip.hidden = true;
    guide.setAttribute('visibility', 'hidden');
  };
}
/**
 * 최신 스냅샷을 HTTP로 다시 읽습니다. 새로고침 버튼과 개발자 GET 확인 버튼이 함께 사용합니다.
 */
async function refresh() {
  renderSnapshot(await api('/snapshot'));
}
/**
 * 선택한 장애의 현재 상태, 분석 이력, 처리 이벤트를 각각 조회해 상세 패널을 구성합니다.
 * 조회자는 읽기만 가능하고 운영자·관리자에게만 분석 및 상태 변경 입력을 제공합니다.
 */
async function showIncident(id) {
  selectedIncident = id;
  await switchTab('incidents');
  const item = snapshot.incidents.find((i) => i.id === id);
  if (!item) return;
  const d = $('incidentDetail');
  d.hidden = false;
  d.replaceChildren(
    el('h2', `#${id} ${item.title}`),
    el('p', `${item.server_name} · ${source(item.source)} · ${status(item.status)}`, 'muted'),
  );
  const actions = el('div', undefined, 'detail-actions');
  const note = el('input');
  note.placeholder = '확인한 내용 또는 해결 조치';
  note.setAttribute('aria-label', '처리 메모');
  if (user.role !== 'viewer' && item.status !== 'resolved') {
    actions.append(note);
    for (const next of item.status === 'open' ? ['acknowledged', 'resolved'] : ['resolved'])
      actions.append(
        action(status(next), async () => {
          await api(`/incidents/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: next, note: note.value }),
          });
          await refresh();
          await showIncident(id);
        }),
      );
  }
  if (user.role !== 'viewer')
    actions.append(
      action(
        'AI 및 매뉴얼 분석',
        async () => {
          const result = await post(`/incidents/${id}/analysis`);
          renderAnalysis(result);
        },
        'subtle',
      ),
    );
  d.append(actions);
  const analysis = el('div');
  analysis.id = 'analysisOutput';
  d.append(analysis);
  const renderAnalysis = (r) => {
    analysis.replaceChildren(
      el(
        'h3',
        r.mode === 'ollama'
          ? 'AI 분석 · 담당자 검토 필요'
          : r.mode === 'abstain'
            ? '근거 부족'
            : '매뉴얼 원문 안내',
      ),
      el('p', `${r.mode} · ${r.retrieval || ''} · ${r.reason || ''}`, 'muted'),
      el('pre', r.answer, 'analysis'),
    );
  };
  const saved = await api(`/incidents/${id}/analysis`);
  if (saved.length) renderAnalysis(saved[0]);
  const events = await api(`/incidents/${id}/events`);
  d.append(el('h3', '처리 이력'));
  const eventView = el('div');
  table(
    eventView,
    ['시간', '담당', '상태', '메모'],
    events.map((e) => [stamp(e.created_at), e.actor, status(e.status), e.note]),
  );
  d.append(eventView);
}
/**
 * 검색 폼의 문자열과 선택 레벨을 URLSearchParams로 인코딩해 최신 로그를 조회합니다.
 */
async function loadLogs() {
  const params = new URLSearchParams(new FormData($('logForm')));
  const rows = await api('/logs?' + params);
  table(
    $('logResults'),
    ['시간', '서버', '출처', '레벨', '내용'],
    rows.map((l) => [
      stamp(l.created_at),
      l.server_name,
      source(l.source),
      pill(l.level, l.level === 'ERROR' ? 'error' : ''),
      el('pre', l.message),
    ]),
  );
}
/**
 * 관리자 전용 사용자 목록·역할 변경 선택 상자·감사 기록을 불러옵니다.
 * 자기 역할 변경은 화면에서도 막지만 최종 권한 검사는 서버 API가 담당합니다.
 */
async function loadAdmin() {
  const users = await api('/users');
  table(
    $('userTable'),
    ['아이디', '역할', '역할 변경'],
    users.map((u) => {
      const select = el('select');
      for (const role of ['viewer', 'operator', 'admin']) {
        const o = el('option', role);
        o.value = role;
        select.append(o);
      }
      select.value = u.role;
      select.disabled = u.id === user.id;
      select.onchange = async () => {
        try {
          await api(`/users/${u.id}/role`, {
            method: 'PATCH',
            body: JSON.stringify({ role: select.value }),
          });
          await loadAdmin();
        } catch (e) {
          notice(e.message);
          select.value = u.role;
        }
      };
      return [u.username, u.role, select];
    }),
  );
  const rows = await api('/audit');
  table(
    $('auditTable'),
    ['시간', '사용자', '행동', '상세'],
    rows.map((a) => [stamp(a.created_at), a.actor, a.action, a.detail]),
  );
}
/**
 * 표시할 화면과 메뉴 선택 상태를 바꾸고 그 화면에 필요한 API만 추가 조회합니다.
 * 관리 화면으로 이동하려는 비관리자는 진입하지 않습니다.
 */
async function switchTab(tab) {
  if (tab === 'admin' && user.role !== 'admin') return;
  currentTab = tab;
  document.querySelectorAll('.page').forEach((n) => (n.hidden = n.id !== tab));
  document
    .querySelectorAll('nav button')
    .forEach((n) => n.classList.toggle('active', n.dataset.tab === tab));
  $('pageTitle').textContent = titles[tab];
  $('pageSubtitle').textContent = {
    dashboard: '인프라의 신호를 연결하고, 장애 대응의 근거를 확인하세요.',
    incidents: '발생한 장애를 분류하고, 확인부터 해결까지 기록하세요.',
    logs: '서버 로그의 맥락과 수집 출처를 함께 확인하세요.',
    servers: '모니터링 대상을 등록하고 수집 상태를 관리하세요.',
    manuals: '장애 대응에 사용하는 운영 근거를 확인하세요.',
    report: '실제 데이터와 가상 데이터를 구분해 운영 현황을 정리합니다.',
    admin: '운영 권한과 변경 이력을 한곳에서 관리하세요.',
  }[tab];
  if (tab === 'logs') await loadLogs();
  if (tab === 'manuals') {
    const docs = await api('/manuals');
    $('manualList').replaceChildren(
      ...docs.map((d) => {
        const n = el('article', undefined, 'panel');
        n.append(el('h2', d.id), el('div', d.body, 'manual-body'));
        return n;
      }),
    );
  }
  if (tab === 'admin') await loadAdmin();
  if (tab === 'report') {
    report = await api('/report');
    $('reportContent').textContent = JSON.stringify(report, null, 2);
  }
}
/**
 * 같은 출처의 인증 WebSocket을 연결하고 snapshot 메시지만 관제 갱신에 사용합니다.
 * 연결이 끊기면 3초 후 세션 유효성을 먼저 확인하고 재접속합니다.
 * 로그아웃 후에는 user가 null이므로 재연결을 예약하지 않습니다.
 */
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => {
    $('connection').textContent = '● 실시간 연결';
    $('connection').className = 'pill';
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'snapshot') renderSnapshot(m.data, 'WS');
  };
  ws.onclose = () => {
    if (user) {
      $('connection').textContent = '재연결 대기';
      $('connection').className = 'pill demo';
      refreshTimer = setTimeout(async () => {
        try {
          await api('/me');
          await refresh();
          connect();
        } catch (e) {
          notice(e.message);
        }
      }, 3000);
    }
  };
}
/**
 * 인증된 사용자 정보를 적용한 뒤 초기 스냅샷을 읽고 WebSocket을 연결합니다.
 * 초기 데이터가 그려진 후에 실시간 메시지가 도착하도록 순서를 유지합니다.
 */
async function enter(u) {
  user = u;
  $('loginView').hidden = true;
  $('console').hidden = false;
  $('userInfo').textContent = `${u.username} / ${u.role}`;
  $('avatar').textContent = u.username.slice(0, 1).toUpperCase();
  $('adminNav').hidden = u.role !== 'admin';
  $('serverEditor').hidden = u.role !== 'admin';
  await refresh();
  await switchTab('dashboard');
  connect();
}
/**
 * 로그인 이벤트: 폼 기본 이동을 막고 API 응답으로 화면을 전환합니다.
 * 성공하면 비밀번호 입력을 비우고, 요청 중에는 제출 버튼을 비활성화합니다.
 */
$('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const b = e.submitter;
  b.disabled = true;
  try {
    await enter(await post('/login', Object.fromEntries(new FormData(e.target))));
    $('loginForm').reset();
    $('loginError').textContent = '';
  } catch (err) {
    $('loginError').textContent = err.message;
  } finally {
    b.disabled = false;
  }
};
/**
 * 로그아웃 API 처리 후 사용자·연결·재시도 타이머를 정리하고 로그인 화면을 표시합니다.
 */
$('logout').onclick = async () => {
  try {
    await post('/logout');
    user = null;
    ws?.close();
    clearTimeout(refreshTimer);
    $('console').hidden = true;
    $('loginView').hidden = false;
  } catch (e) {
    notice(e.message);
  }
};
document
  .querySelectorAll('[data-tab]')
  .forEach((b) => (b.onclick = () => switchTab(b.dataset.tab).catch((e) => notice(e.message))));
$('chartServer').onchange = () => drawChart().catch((e) => notice(e.message));
$('logForm').onsubmit = (e) => {
  e.preventDefault();
  void loadLogs().catch((err) => notice(err.message));
};
/**
 * 관리자 서버 등록: 한 번 발급되는 토큰을 등록 결과 영역에만 보여 줍니다.
 * 이 토큰을 화면 캡처·보고서·Git에 포함하지 않도록 관리해야 합니다.
 */
$('serverForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const r = await post('/servers', Object.fromEntries(new FormData(e.target)));
    $('agentToken').textContent = r.agentToken
      ? `수집 토큰 (이 화면에서 한 번만 표시): ${r.agentToken}\n서버 ID: ${r.id}`
      : '가상 데모 서버 등록 완료';
    e.target.reset();
    await refresh();
  } catch (err) {
    notice(err.message);
  }
};
/**
 * 관리자 계정 생성: 폼의 값은 API로 검증하며 생성 후 비밀번호 입력을 포함한 폼을 비웁니다.
 */
$('userForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await post('/users', Object.fromEntries(new FormData(e.target)));
    e.target.reset();
    await loadAdmin();
  } catch (err) {
    notice(err.message);
  }
};
/**
 * 읽어 둔 운영 보고서 JSON을 브라우저 Blob으로 내려받습니다.
 * 서버에 임시 파일을 만들지 않으며 사용한 객체 URL은 잠시 뒤 해제합니다.
 */
$('downloadReport').onclick = () => {
  if (!report) return;
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
    url = URL.createObjectURL(blob),
    a = el('a');
  a.href = url;
  a.download = 'OpsMate_운영보고서.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
document.querySelectorAll('nav [data-tab]').forEach((b) => b.prepend(icon(b.dataset.tab)));
$('refreshDashboard').prepend(icon('refresh'));
$('refreshDashboard').onclick = async () => {
  const b = $('refreshDashboard');
  b.disabled = true;
  try {
    await refresh();
    if (currentTab === 'logs') await loadLogs();
    if (currentTab === 'admin') await loadAdmin();
  } catch (e) {
    notice(e.message);
  } finally {
    b.disabled = false;
  }
};
/**
 * 필요한 DOM이 준비된 뒤 코드 패널의 이벤트를 연결합니다.
 * refresh 함수를 주입하므로 코드 문자열을 eval하거나 에이전트 예시를 자동 실행하지 않습니다.
 */
initializeDeveloperWorkbench({ refresh, onError: notice });
try {
  await enter(await api('/me'));
} catch {
  /* 미인증 상태는 로그인 화면을 그대로 유지합니다. */
}
