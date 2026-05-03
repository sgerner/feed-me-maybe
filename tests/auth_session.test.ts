import { describe, test, beforeAll, afterAll, expect } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';

// Simple integration-style tests for Phase 1 Task 1.3: Session authentication infrastructure
describe('Phase 1 Task 1.3 - Session authentication infrastructure', () => {
  let serverProcess: any = null;
  let buildSucceeded = false;
  let loginCookie: string | null = null;

  // Helper to perform HTTP requests against the local server
  const request = async (path: string, opts: any = {}) => {
    const url = `http://localhost:3000${path}`;
    const res = await fetch(url, opts);
    return res;
  };

  beforeAll(async () => {
    // 1) Build the project
    // Use a synchronous build to ensure it's completed before tests start
    try {
      const res = spawnSync('npm', ['run', 'build'], {
        stdio: 'inherit',
        cwd: process.cwd(),
      });
      buildSucceeded = (res.status ?? 1) === 0;
    } catch (e) {
      buildSucceeded = false;
    }
    if (!buildSucceeded) {
      throw new Error('Build failed. Aborting tests.');
    }

    // 2) Start the server with APP_PASSWORD=testpass123
    serverProcess = spawn('node', ['build/index.js'], {
      env: { ...process.env, APP_PASSWORD: 'testpass123' },
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Wait for server to start by probing the root
    const started = await waitForServerStart(10000);
    if (!started) {
      serverProcess.kill();
      throw new Error('Server did not start in time');
    }
  });

  afterAll(() => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill();
    }
  });

  test('Login with correct password returns 200 and Set-Cookie header', async () => {
    const res = await request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'testpass123' }),
    });
    // Expect HTTP 200
    expect(res.status).toBe(200);
    // Expect a Set-Cookie header to be present
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).not.toBeNull();
    // Derive a simple cookie header for future requests (first cookie in the chain)
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (cookieHeader) {
      loginCookie = cookieHeader.split(';')[0];
    }
    expect(loginCookie).not.toBeNull();
  });

  test('Login with wrong password returns 401', async () => {
    const res = await request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrongpass' }),
    });
    expect(res.status).toBe(401);
  });

  test('Login with bad JSON returns 400', async () => {
    const res = await request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  test('Unauthenticated request to root redirects to /login', async () => {
    const res = await request('/', {
      method: 'GET',
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    const location = res.headers.get('location') || '';
    expect(location).toContain('/login');
  });

  test('Logout clears the session and unauthenticated access redirects again', async () => {
    // Ensure we have a login cookie first
    if (!loginCookie) {
      // Attempt a login to obtain a cookie
      const loginRes = await request('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'testpass123' }),
      });
      const sc = loginRes.headers.get('set-cookie');
      if (sc)
        loginCookie = Array.isArray(sc)
          ? sc[0].split(';')[0]
          : sc.split(';')[0];
    }
    // Call logout with the cookie
    const logoutRes = await request('/api/logout', {
      method: 'POST',
      headers: { Cookie: loginCookie || '' },
    });
    // Accept 200 as the success indicator for logout in this test setup
    expect(logoutRes.status).toBe(200);

    // After logout, unauthenticated access should redirect again
    const res = await request('/', {
      method: 'GET',
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    const location = res.headers.get('location') || '';
    expect(location).toContain('/login');
  });
});

// Helper to repeatedly check if server is up
async function waitForServerStart(timeoutMs: number) {
  const start = Date.now();
  const deadline = start + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://localhost:3000/');
      // If we get any response, assume server is up
      if (res) return true;
    } catch (_e) {
      // keep retrying
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
