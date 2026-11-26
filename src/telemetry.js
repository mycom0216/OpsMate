/**
 * 실행 호스트에서 실제 지표를 읽는 수집기와 가상 데모 생성기를 분리한 모듈입니다.
 * CPU·RAM·Disk는 %, 네트워크는 바이트/초입니다. 미수집은 0 대신 null입니다.
 * OS 조회는 고정된 읽기 전용 작업이며 AI 응답이나 사용자의 명령을 실행하지 않습니다.
 */
import os from 'node:os';
import { statfs, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
/**
 * 화면과 DB에 저장할 수치를 소수점 둘째 자리까지 반올림합니다.
 */
const round = (x) => Math.round(x * 100) / 100;
/**
 * 모든 CPU 코어의 누적 idle 시간과 전체 작업 시간을 합산합니다.
 * 이 누적값 자체는 사용률이 아니며, 이전 호출과의 시간 차이로 사용률을 계산합니다.
 */
const cpuTimes = () =>
  os.cpus().reduce(
    (a, c) => {
      a.idle += c.times.idle;
      a.total += Object.values(c.times).reduce((x, y) => x + y, 0);
      return a;
    },
    { idle: 0, total: 0 },
  );
/**
 * 이전 CPU·네트워크 카운터를 보관하는 수집 함수를 생성합니다.
 * 매번 새 수집기를 만들면 이전 값이 사라지므로 서버/에이전트 실행 중 하나를 재사용합니다.
 * RAM은 OS 전체 사용률이며 메모리 압박이나 누수의 확정 근거는 아닙니다.
 * Disk는 작업 폴더가 위치한 볼륨의 사용률입니다. 모든 디스크의 평균이 아닙니다.
 * @returns {Function} 호출하면 측정 객체를 반환하는 비동기 함수
 */
export function createCollector() {
  let lastCPU = cpuTimes(),
    lastNet = null;
  return async () => {
    const cpu = cpuTimes();
    /**
     * CPU 사용률 = 1 - (이번 idle 증가량 / 이번 전체 시간 증가량)입니다.
     * 측정 간격이 너무 짧아 차이가 없으면 나눗셈 대신 null을 사용합니다.
     */
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
      /**
       * Linux에서는 /proc/net/dev의 누적 RX/TX 바이트를 합칩니다.
       * 내부 루프백 lo는 제외하고, Windows에서는 어댑터 통계를 별도 고정 명령으로 읽습니다.
       */
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
      /**
       * 누적 바이트 차이를 실제 경과 초로 나눠 B/s를 구합니다.
       * 최초 호출, 카운터 감소/리셋, 시간 역전에서는 속도를 만들지 않고 null을 유지합니다.
       * 여러 어댑터 합계이므로 물리 링크 사용률이나 패킷 손실률로 해석하면 안 됩니다.
       */
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
/**
 * 시연 화면의 가상 서버에만 사용하는 반복 가능한 지표를 만듭니다.
 * Disk를 91%로 유지해 경고 장애를 보여 줍니다. 실제 호스트 수집의 대체 값이 아닙니다.
 * @param {number} tick 서버 수집 사이클 횟수
 * @returns {Object} 실제 수집기와 필드 형태만 같은 가상 측정값
 */
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
