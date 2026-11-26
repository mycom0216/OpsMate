/** 임계치 초과를 분류합니다. 같은 서버·분류의 미해결 장애는 한 건만 유지합니다. */
import { now } from './security.js';
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
