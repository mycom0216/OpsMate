/**
 * 측정값을 장애 후보로 분류하고 DB에 저장하는 모듈입니다.
 * 감지는 단일 샘플 기준이며 정상 값으로 돌아와도 자동 해결하지 않습니다.
 * 읽는 순서: classify → openIncident → saveSample. 담당자의 해결 처리는 server.js에 있습니다.
 */
import { now } from './security.js';
/**
 * CPU 85%, RAM 90%, Disk 90% 이상인 항목마다 장애 후보를 만듭니다.
 * 각 항목이 97% 이상이면 critical, 그 미만이면 warning으로 분류합니다.
 * null은 미수집이므로 장애 후보에 포함하지 않습니다. 단위는 모두 백분율입니다.
 * @param {Object} sample cpu, ram, disk가 수치 또는 null인 한 번의 측정값
 * @returns {Array<Object>} category, severity, title을 가진 후보 배열
 */
export function classify(sample) {
  return [
    ['cpu', 85, 'CPU'],
    ['ram', 90, 'MEMORY'],
    ['disk', 90, 'DISK'],
  ]
    .filter(([key, threshold]) => sample[key] !== null && sample[key] >= threshold)
    .map(([key, , category]) => ({
      category,
      severity: sample[key] >= 97 ? 'critical' : 'warning',
      title: `${category} 사용률 ${sample[key]}%`,
    }));
}
/**
 * 같은 서버·분류에 미해결 장애가 없다면 접수 상태로 만들고 자동 감지 이력을 남깁니다.
 * 먼저 조회하고, INSERT 사이의 동시 요청은 DB의 active_key UNIQUE 제약으로 억제합니다.
 * 충돌 후 기존 행이 확인되면 새 장애를 만들지 않고, 그렇지 않은 DB 오류는 다시 던집니다.
 * @param {Object} db 저장소
 * @param {Object} server id와 source를 가진 등록 서버. 출처는 요청 본문에서 받지 않습니다.
 * @param {Object} alert category, severity, title을 가진 장애 후보
 * @returns {Promise<number|null>} 신규 장애 ID. 기존 미해결 건이 있으면 null
 */
export async function openIncident(db, server, alert) {
  const key = `${server.id}:${alert.category}`;
  if (await db.get('SELECT id FROM incidents WHERE active_key=?', [key])) return null;
  let result;
  try {
    result = await db.run(
      'INSERT INTO incidents(server_id,category,severity,status,title,source,active_key,opened_at) VALUES(?,?,?,?,?,?,?,?)',
      [server.id, alert.category, alert.severity, 'open', alert.title, server.source, key, now()],
    );
  } catch (e) {
    if (await db.get('SELECT id FROM incidents WHERE active_key=?', [key])) return null;
    throw e;
  }
  await db.run(
    'INSERT INTO incident_events(incident_id,actor,status,note,created_at) VALUES(?,?,?,?,?)',
    [Number(result.lastInsertRowid), 'system', 'open', '자동 감지', now()],
  );
  return Number(result.lastInsertRowid);
}
/**
 * 측정 이력 한 건을 먼저 저장하고 초과 항목을 classify로 분류해 장애를 생성합니다.
 * 실제/가상 출처는 server.source를 따라 지표와 장애에 동일하게 기록됩니다.
 * 입력 범위 검사는 원격 API에서 하고, 로컬 수집값은 telemetry.js가 생성합니다.
 * @param {Object} db 저장소
 * @param {Object} server 등록 서버
 * @param {Object} sample CPU·RAM·Disk·RX/TX·sampled_at을 가진 측정값
 * @returns {Promise<void>} 지표 저장과 해당 후보의 장애 생성 완료
 */
export async function saveSample(db, server, sample) {
  await db.run(
    'INSERT INTO metrics(server_id,cpu,ram,disk,network_rx,network_tx,source,sampled_at) VALUES(?,?,?,?,?,?,?,?)',
    [
      server.id,
      sample.cpu,
      sample.ram,
      sample.disk,
      sample.network_rx,
      sample.network_tx,
      server.source,
      sample.sampled_at,
    ],
  );
  for (const alert of classify(sample)) await openIncident(db, server, alert);
}
