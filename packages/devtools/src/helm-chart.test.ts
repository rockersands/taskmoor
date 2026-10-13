import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CHART = join(ROOT, 'deploy', 'helm', 'taskmoor');

/** Helm from PATH, or the copy tools download into .cache/tools; the tests skip without one. */
function findHelm(): string | undefined {
  const local = join(ROOT, '.cache', 'tools', 'helm', 'windows-amd64', 'helm.exe');
  if (existsSync(local)) return local;
  try {
    execFileSync('helm', ['version', '--short'], { stdio: 'ignore' });
    return 'helm';
  } catch {
    return undefined;
  }
}

const helm = findHelm();

function render(sets: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync(
      helm as string,
      ['template', 't', CHART, ...sets.flatMap((s) => ['--set', s])],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return { ok: true, out };
  } catch (error) {
    return { ok: false, out: String((error as { stderr?: string }).stderr ?? error) };
  }
}

const kinds = (out: string) => [...out.matchAll(/^kind: (\w+)$/gm)].map((m) => m[1]).sort();

describe.skipIf(!helm)('Helm chart', () => {
  it('[OPS-018] passes helm lint', () => {
    const out = execFileSync(
      helm as string,
      ['lint', CHART, '--set', 'database.url=postgres://u:p@db/ts'],
      {
        encoding: 'utf8',
      },
    );
    expect(out).toContain('0 chart(s) failed');
  });

  it('[OPS-018] renders a single-pod install with a volume and the safety settings', () => {
    const { ok, out } = render(['database.url=postgres://u:p@db/ts']);
    expect(ok, out).toBe(true);
    expect(kinds(out)).toEqual([
      'Deployment',
      'Deployment',
      'Job',
      'PersistentVolumeClaim',
      'Pod',
      'Secret',
      'Secret',
      'Service',
      'Service',
      'ServiceAccount',
    ]);
    expect(out).not.toContain('PodDisruptionBudget');
    // One password pepper for every pod, kept across upgrades and uninstalls (ASVS 2.4.5).
    expect(out).toContain('-taskmoor-password-pepper');
    expect(out).toContain('helm.sh/resource-policy: keep');
    expect(out).toContain('- name: TASKMOOR_PASSWORD_PEPPER');
    expect(out).toContain('value: "loopback,uniquelocal"');
    expect(out).toContain('readOnlyRootFilesystem: true');
    expect(out).toContain('maxUnavailable: 0');
    expect(out).toContain('preStop:');
    expect(out).toContain('exec: { command: ["sleep", "10"] }');
    expect(out).toContain('helm.sh/hook: pre-upgrade');
  });

  it('[OPS-018] renders the HA shape: autoscaler, disruption budgets, S3, ServiceMonitor', () => {
    const { ok, out } = render([
      'database.existingSecret=db',
      'storage.type=s3',
      'storage.s3.bucket=files',
      'app.autoscaling.enabled=true',
      'worker.replicas=2',
      'worker.podDisruptionBudget.enabled=true',
      'metrics.serviceMonitor.enabled=true',
      'ingress.enabled=true',
    ]);
    expect(ok, out).toBe(true);
    const counts = kinds(out).reduce<Record<string, number>>((acc, k) => {
      acc[k as string] = (acc[k as string] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toMatchObject({
      HorizontalPodAutoscaler: 1,
      PodDisruptionBudget: 2,
      ServiceMonitor: 1,
      Ingress: 1,
    });
    expect(counts.PersistentVolumeClaim).toBeUndefined();
    expect(out).toContain('name: S3_BUCKET');
  });

  it('[OPS-018] refuses settings that cannot work', () => {
    expect(render([]).out).toContain('Set database.existingSecret (recommended) or database.url');
    expect(render(['database.url=x', 'app.replicas=2']).out).toContain('allows one app pod');
    expect(render(['database.url=x', 'storage.type=s3']).out).toContain(
      'storage.s3.bucket is required',
    );
    expect(render(['database.url=x', 'storage.type=nfs']).out).toContain(
      'storage.type must be local or s3',
    );
  });
});
