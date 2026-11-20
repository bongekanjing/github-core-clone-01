// Entry point for github-core-clone-01.
//
// The forge's HTTP surface is built by app.ts; this file does the three things the harness's env
// expects of a trial program, and nothing else:
//
//  1. The env's origin arrives in MAKEFUN_ENV_URL. No env, no trial: exit 1 straight away.
//  2. Bind port 0 so the kernel picks a free port, then POST {"port": <n>} to <env>/register. The env
//     keeps the caller's address plus that port as our base URL and drives the forge from there.
//     Port 8080 belongs to the env, so it is never ours to bind.
//  3. Poll <env>/done. It answers {"done": false} while the suite runs and {"done": true} once its
//     export is on disk; only then does this process close the server and exit 0. Exiting early
//     loses the trial, so the poll never gives up.
//
// Nothing here imports a package: only node:net's types and app.ts itself.

import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';

const ENV_ORIGIN = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_START_MS = 250;
const RETRY_CEILING_MS = 2_000;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** How long to wait after the `attempt`-th failure: doubling from 250ms, never above 2s. */
function backoff(attempt: number): number {
  const doubled = RETRY_START_MS * 2 ** Math.min(attempt, 8);
  return doubled > RETRY_CEILING_MS ? RETRY_CEILING_MS : doubled;
}

/**
 * Tell the env which port we bound, until it accepts it. 200 is the normal answer; 409 says an
 * earlier register already won the base URL, which is not ours to fix, so it counts as accepted.
 * 400 and 405 mean this program speaks the wrong contract and cannot recover; anything else (a
 * refused connection while the env comes up, a timeout) is worth another try.
 */
async function announcePort(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    let fatal = false;
    try {
      const res = await fetch(`${ENV_ORIGIN}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) fatal = true;
    } catch {
      // Nothing heard from the env: it is still starting, or this attempt timed out.
    }
    if (fatal) throw new Error('the env rejected the register request with 400 or 405');
    await pause(backoff(attempt));
  }
}

/** Poll until the env reports the trial over. Returns only on {"done": true}. */
async function awaitTrialEnd(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_ORIGIN}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const payload = (await res.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // An unanswered poll is simply not a finished trial: try again after a pause.
    }
    await pause(backoff(attempt));
  }
}

async function run(): Promise<void> {
  if (ENV_ORIGIN === '') {
    process.stderr.write('[forge] MAKEFUN_ENV_URL is unset, so there is no env to register with\n');
    process.exit(1);
  }

  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, resolve);
  });

  const bound = server.address() as AddressInfo | string | null;
  if (bound === null || typeof bound === 'string') {
    throw new Error('the forge server did not take an ephemeral TCP port');
  }
  process.stdout.write(`[forge] serving on 0.0.0.0:${bound.port}\n`);

  await announcePort(bound.port);
  process.stdout.write('[forge] registered with the env; serving until it says done\n');

  await awaitTrialEnd();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.stdout.write('[forge] trial over, exiting 0\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
