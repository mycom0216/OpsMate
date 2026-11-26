/** 실행 호스트의 실제 지표를 수집합니다. 지원하지 않는 값은 0 대신 null입니다. */
import os from 'node:os';
import { statfs, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
const round = (x) => Math.round(x * 100) / 100;
const cpuTimes = () =>
  os.cpus().reduce(
    (a, c) => {
      a.idle += c.times.idle;
      a.total += Object.values(c.times).reduce((x, y) => x + y, 0);
      return a;
    },
    { idle: 0, total: 0 },
  );
export function createCollector() {
  let lastCPU = cpuTimes(),
    lastNet = null;
  return async () => {
    const cpu = cpuTimes();
    const delta = cpu.total - lastCPU.total;
    const sample = {
      cpu: delta > 0 ? round(100 * (1 - (cpu.idle - lastCPU.idle) / delta)) : null,
      ram: round(100 * (1 - os.freemem() / os.totalmem())),
      disk: null,
      network_rx: null,
      network_tx: null,
      sampled_at: new Date().toISOString(),
    };
    lastCPU = cpu;
    try {
      const f = await statfs(process.cwd());
      sample.disk = f.blocks ? round(100 * (1 - f.bavail / f.blocks)) : null;
    } catch {
      /* 파일시스템 API 미지원은 수집 실패로 표시합니다. */
    }
    try {
      let rx = 0,
        tx = 0;
      if (process.platform === 'linux') {
        const text = await readFile('/proc/net/dev', 'utf8');
        for (const line of text.split('\n').slice(2)) {
          const parts = line.split(':');
          if (parts.length !== 2 || parts[0].trim() === 'lo') continue;
          const v = parts[1].trim().split(/\s+/).map(Number);
          rx += v[0];
          tx += v[8];
        }
      } else if (process.platform === 'win32') {
        // 고정된 읽기 전용 수집 명령만 실행합니다. 사용자/AI 문자열을 명령에 연결하지 않습니다.
        const { stdout } = await execFileAsync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Get-NetAdapterStatistics | Select-Object ReceivedBytes,SentBytes | ConvertTo-Json -Compress',
          ],
          { windowsHide: true, timeout: 4000, maxBuffer: 100000 },
        );
        const parsed = JSON.parse(stdout);
        for (const v of Array.isArray(parsed) ? parsed : [parsed]) {
          if (v) {
            rx += Number(v.ReceivedBytes);
            tx += Number(v.SentBytes);
          }
        }
      } else throw new Error('지원하지 않는 네트워크 수집 OS');
      const at = Date.now();
      if (lastNet && at > lastNet.at && rx >= lastNet.rx && tx >= lastNet.tx) {
        sample.network_rx = round((rx - lastNet.rx) / ((at - lastNet.at) / 1000));
        sample.network_tx = round((tx - lastNet.tx) / ((at - lastNet.at) / 1000));
      }
      lastNet = { rx, tx, at };
    } catch {
      /* 권한/도구 부재 시 네트워크를 미수집으로 유지합니다. */
    }
    return sample;
  };
}

/** 가상 지표 생성기는 데모 서버에만 사용하며 실제 수집기와 분리합니다. */
export function demoSample(tick = 0) {
  return {
    cpu: round(56 + 40 * Math.sin(tick / 4)),
    ram: round(61 + 12 * Math.sin(tick / 7)),
    disk: 91,
    network_rx: 180000 + (tick % 10) * 10000,
    network_tx: 70000,
    sampled_at: new Date().toISOString(),
  };
}
