import { after } from "next/server";

/**
 * Runs work after the HTTP response has been sent, and keeps it alive on serverless hosts.
 *
 * A bare un-awaited promise in a route handler is NOT safe on Vercel-style hosts: the function
 * can be frozen the moment the response is returned, leaving the pipeline half-run and the
 * invoice stuck at "processing". Next's `after()` tells the platform to keep the invocation
 * alive until the task settles. Failures are logged with the label so they can be found.
 */
export function runInBackground(label: string, task: () => Promise<unknown>): void {
  const guarded = async () => {
    try {
      await task();
    } catch (e) {
      console.error(`${label} failed:`, e);
    }
  };
  try {
    after(guarded);
  } catch (e) {
    // Outside a Next request (unit tests, scripts) there is no platform to keep the work alive,
    // so just start it. Any other failure of after() is a real error and propagates.
    if (!(e instanceof Error) || !/request scope/i.test(e.message)) throw e;
    void guarded();
  }
}
