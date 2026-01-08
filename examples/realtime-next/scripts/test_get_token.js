import fetch from 'node-fetch';

async function test() {
  try {
    const res = await fetch('http://127.0.0.1:8000/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-realtime' }),
    });

    const text = await res.text();
    console.log('status', res.status);
    console.log('body', text);
  } catch (err) {
    console.error('fetch failed', err);
  }
}

test();
