'use strict';

const fs = require('node:fs');

if (process.env.DISCORD_CODING_STATUS_MOCK_CLAUDE_FETCH === '1') {
  const requestLogFile = process.env.DISCORD_CODING_STATUS_CLAUDE_REQUEST_LOG_FILE;
  const responseDelayMs = Number(process.env.DISCORD_CODING_STATUS_MOCK_CLAUDE_DELAY_MS || '0');

  global.fetch = async (url, options = {}) => {
    const requestUrl = String(url);
    if (requestUrl !== 'https://api.anthropic.com/api/oauth/usage') {
      throw new Error(`Unexpected Claude test request: ${requestUrl}`);
    }

    const headers = new Headers(options.headers || {});
    if (requestLogFile) {
      fs.appendFileSync(requestLogFile, `${JSON.stringify({
        url: requestUrl,
        method: options.method,
        hasBearerToken: /^Bearer\s+\S+$/.test(headers.get('authorization') || ''),
        beta: headers.get('anthropic-beta'),
        userAgent: headers.get('user-agent')
      })}\n`);
    }

    if (responseDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, responseDelayMs));
    }

    return new Response(JSON.stringify({
      five_hour: { utilization: 25, resets_at: '2026-07-18T08:00:00Z' },
      seven_day: { utilization: 40, resets_at: '2026-07-21T00:00:00Z' }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
}
