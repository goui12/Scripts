'use strict';

// Every network fixture binds IPv4 loopback on an ephemeral port. No real panel
// is contacted and no credentials, ARP queries, or external modules are used.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const { TelnetClient } = require('../lib/telnet-client.cjs');

async function fixture(onConnection, body, clientOptions = {}) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    onConnection(socket);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const client = new TelnetClient(clientOptions);
  try {
    await body({ client, port, sockets });
  } finally {
    client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

test('buffers immediate data before waitFor and retains following prompts', async () => {
  await fixture(socket => socket.write('Banner\r\nFirst>suffix\r\nSecond>'), async ({ client, port }) => {
    await client.connect('127.0.0.1', port);
    await delay(30);
    assert.equal(await client.waitFor('First>'), 'Banner\nFirst>');
    assert.equal(await client.waitFor('Second>'), 'suffix\nSecond>');
    assert.equal(client.drain(), '');
  });
});

test('handles fragmented prompts and fragmented ANSI controls', async () => {
  await fixture(socket => {
    void (async () => {
      for (const fragment of ['\x1b', '[3', '2mWel', 'come\x1b[0m\r', '\nenter us', 'er initials:']) {
        if (socket.destroyed) return;
        socket.write(fragment);
        await delay(3);
      }
    })();
  }, async ({ client, port }) => {
    await client.connect('127.0.0.1', port);
    assert.equal(await client.waitFor(/enter user initials:/i), 'Welcome\nenter user initials:');
  });
});

test('does not treat silence or a partial prompt as completion', async () => {
  let peer;
  await fixture(socket => { peer = socket; socket.write('Report\r\nEnd of rep'); }, async ({ client, port }) => {
    await client.connect('127.0.0.1', port);
    let completed = false;
    const response = client.waitFor('End of report').then(value => { completed = true; return value; });
    await delay(40);
    assert.equal(completed, false);
    peer.write('ort');
    assert.equal(await response, 'Report\nEnd of report');
  });
});

test('literal prompts escape regex syntax and RegExp state flags are harmless', async () => {
  await fixture(socket => socket.write('Point [A+B] (1)? Next>'), async ({ client, port }) => {
    await client.connect('127.0.0.1', port);
    assert.equal(await client.waitFor('Point [A+B] (1)?'), 'Point [A+B] (1)?');
    const pattern = /Next>/gy;
    pattern.lastIndex = 99;
    assert.equal(await client.waitFor(pattern), ' Next>');
    assert.equal(pattern.lastIndex, 99);
  });
});

test('negotiates known options, refuses unknown options, and suppresses repeated replies', async () => {
  const received = [];
  const commands = [
    255, 251, 1, // WILL ECHO -> DO ECHO
    255, 251, 1, // repeat -> no reply
    255, 251, 3, // WILL SGA -> DO SGA
    255, 251, 0, // WILL BINARY -> DO BINARY
    255, 253, 0, // DO BINARY -> WILL BINARY
    255, 253, 3, // DO SGA -> WILL SGA
    255, 253, 1, // DO ECHO -> WONT ECHO (no local echo)
    255, 251, 99, // unknown remote -> DONT
    255, 251, 99, // repeat -> no reply
    255, 253, 99, // unknown local -> WONT
    255, 253, 99, // repeat -> no reply
    255, 252, 1, // WONT prior remote ECHO -> DONT
    255, 254, 3, // DONT prior local SGA -> WONT
  ];
  await fixture(socket => {
    socket.on('data', data => received.push(data));
    void (async () => {
      for (const byte of commands) {
        if (socket.destroyed) return;
        socket.write(Buffer.from([byte]));
        await delay(1);
      }
      socket.write('Ready>');
    })();
  }, async ({ client, port }) => {
    await client.connect('127.0.0.1', port);
    assert.equal(await client.waitFor('Ready>'), 'Ready>');
    await delay(25);
    assert.deepEqual([...Buffer.concat(received)], [
      255, 253, 1, 255, 253, 3, 255, 253, 0,
      255, 251, 0, 255, 251, 3, 255, 252, 1,
      255, 254, 99, 255, 252, 99, 255, 254, 1, 255, 252, 3,
    ]);
  });
});

test('ignores chunked subnegotiation and preserves escaped IAC as data', async () => {
  await fixture(socket => {
    void (async () => {
      const fragments = [
        Buffer.from('ab'), Buffer.from([255, 250, 24, 1, 65, 255]),
        Buffer.from([255, 66, 255]), Buffer.from([240, 255]),
        Buffer.from([255]), Buffer.from('cd>'),
      ];
      for (const fragment of fragments) {
        if (socket.destroyed) return;
        socket.write(fragment);
        await delay(2);
      }
    })();
  }, async ({ client, port }) => {
    await client.connect('127.0.0.1', port);
    assert.equal(await client.waitFor('cd>'), 'ab\xffcd>');
  });
});

test('normalizes CRLF, NVT CR-NUL, lone CR, tabs, and backspaces', async () => {
  await fixture(socket => socket.write(Buffer.from('A\r\nB\r\0C\rD\bE\t!\x07', 'latin1')), async ({ client, port }) => {
    await client.connect('127.0.0.1', port);
    assert.equal(await client.waitFor('!'), 'A\nB\nC\nE\t!');
  });
});

test('strips fragmented OSC/DCS sequences without discarding report text', async () => {
  await fixture(socket => {
    socket.write('A\x1b]title');
    setTimeout(() => socket.write('\x1b\\B\x1bPignored\x1b\\C\x1b(BD>'), 5);
  }, async ({ client, port }) => {
    await client.connect('127.0.0.1', port);
    assert.equal(await client.waitFor('>'), 'ABCD>');
  });
});

test('send adds no newline, escapes IAC, and does not echo or log application data', async () => {
  const received = [];
  let peer;
  await fixture(socket => { peer = socket; socket.on('data', data => received.push(data)); }, async ({ client, port }) => {
    await client.connect('127.0.0.1', port);
    client.send('P');
    client.send('L');
    client.send('\r\n');
    client.send('\xff');
    await delay(25);
    assert.deepEqual([...Buffer.concat(received)], [80, 76, 13, 10, 255, 255]);
    assert.equal(client.drain(), '');
    peer.write('Done>');
    assert.equal(await client.waitFor('Done>'), 'Done>');
  });
});

test('prompt timeout closes the socket and clears partial content', async () => {
  await fixture(socket => socket.write('Private partial response'), async ({ client, port }) => {
    await client.connect('127.0.0.1', port);
    await assert.rejects(client.waitFor('Never>', { timeoutMs: 35 }), /prompt timeout/);
    assert.equal(client.socket.destroyed, true);
    assert.equal(client.drain(), '');
    assert.throws(() => client.send('P'), /prompt timeout/);
  });
});

test('per-wait response cap aborts oversized data and clears buffers', async () => {
  let peer;
  await fixture(socket => { peer = socket; }, async ({ client, port }) => {
    await client.connect('127.0.0.1', port);
    const response = client.waitFor('End>', { maxBytes: 12 });
    peer.write('1234567890123End>');
    await assert.rejects(response, /byte limit/);
    assert.equal(client.socket.destroyed, true);
    assert.equal(client.drain(), '');
  });
});

test('global response cap also bounds data received before waiting', async () => {
  await fixture(socket => socket.write('x'.repeat(100)), async ({ client, port }) => {
    await client.connect('127.0.0.1', port);
    await delay(25);
    await assert.rejects(client.waitFor('End>'), /byte limit/);
    assert.equal(client.socket.destroyed, true);
    assert.equal(client.drain(), '');
  }, { maxBufferedBytes: 32 });
});

test('raw byte cap includes discarded ANSI/control traffic', async () => {
  let peer;
  await fixture(socket => { peer = socket; }, async ({ client, port }) => {
    await client.connect('127.0.0.1', port);
    const response = client.waitFor('End>', { maxBytes: 32 });
    peer.write('\x1b[0m'.repeat(20));
    await assert.rejects(response, /byte limit/);
    assert.equal(client.drain(), '');
  });
});

test('EOF rejects an incomplete prompt and explicit close is idempotent', async () => {
  let peer;
  await fixture(socket => { peer = socket; }, async ({ client, port }) => {
    await client.connect('127.0.0.1', port);
    const response = client.waitFor('Done>');
    peer.end('incomplete');
    await assert.rejects(response, /closed/);
    client.close();
    client.close();
    assert.equal(client.socket.destroyed, true);
    assert.equal(client.drain(), '');
  });
});

test('rejects concurrent waits, drains during waits, and empty-match patterns', async () => {
  await fixture(() => {}, async ({ client, port }) => {
    await client.connect('127.0.0.1', port);
    await assert.rejects(client.waitFor(''), /must not be empty/);
    await assert.rejects(client.waitFor(/.*/), /empty string/);
    const first = client.waitFor('Done>');
    await assert.rejects(client.waitFor('Other>'), /one prompt wait/);
    assert.throws(() => client.drain(), /during a prompt wait/);
    client.close();
    await assert.rejects(first, /client closed/);
  });
});

test('rejects invalid input before connection and unsupported text before writing', async () => {
  const unused = new TelnetClient();
  await assert.rejects(unused.connect('', 23), /nonempty/);
  await assert.rejects(unused.connect('127.0.0.1', 65536), /65535/);
  await assert.rejects(unused.connect('127.0.0.1', 23, 0), /positive/);
  assert.throws(() => new TelnetClient({ maxBufferedBytes: 0 }), /positive/);
  await fixture(() => {}, async ({ client, port }) => {
    await client.connect('127.0.0.1', port);
    assert.throws(() => client.send('\u2603'), /Latin-1/);
    assert.throws(() => client.send('a'.repeat(65537)), /65536/);
    assert.throws(() => client.send(null), /string/);
  });
});

test('refused loopback connection rejects promptly and is cleaned up', async () => {
  const temporary = net.createServer();
  await new Promise(resolve => temporary.listen(0, '127.0.0.1', resolve));
  const port = temporary.address().port;
  await new Promise(resolve => temporary.close(resolve));
  const client = new TelnetClient();
  try {
    await assert.rejects(client.connect('127.0.0.1', port, 200));
    assert.equal(client.socket.destroyed, true);
  } finally {
    client.close();
  }
});

test('old socket events cannot close an explicitly reconnected client', async () => {
  await fixture(socket => socket.write('Ready>'), async ({ client, port }) => {
    await client.connect('127.0.0.1', port);
    assert.equal(await client.waitFor('Ready>'), 'Ready>');
    client.close();
    await client.connect('127.0.0.1', port);
    assert.equal(await client.waitFor('Ready>'), 'Ready>');
    assert.equal(client.socket.destroyed, false);
  });
});

test('optional failure observer sees a bounded snapshot before cleanup, and its error cannot block cleanup', async () => {
  const snapshots = [];
  await fixture(socket => socket.write('unfinished response'), async ({ client, port }) => {
    await client.connect('127.0.0.1', port);
    await assert.rejects(client.waitFor('Never>', { timeoutMs: 30 }), /timeout/);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].partial, 'unfinished response');
    assert.equal(client.drain(), '');
    assert.equal(client.socket.destroyed, true);
    client.close();
    assert.equal(snapshots.length, 1);
  }, { onFailure: snapshot => { snapshots.push(snapshot); throw new Error('observer failure'); } });
  assert.throws(() => new TelnetClient({ onFailure: true }), /onFailure/);
});

test('a failure observer may close again without recursive callbacks', async () => {
  let calls = 0, observerClient;
  await fixture(socket => socket.write('partial'), async ({ client, port }) => {
    observerClient = client;
    await client.connect('127.0.0.1', port);
    await assert.rejects(client.waitFor('Never>', { timeoutMs: 30 }), /timeout/);
    assert.equal(calls, 1);
    assert.equal(client.socket.destroyed, true);
  }, { onFailure: () => { calls++; observerClient.close(); } });
});

test('a final explicit completion line is delivered even when the peer ends in the same write', async () => {
  await fixture(socket => socket.end('Y\r\nGood Bye\r\n'), async ({ client, port }) => {
    await client.connect('127.0.0.1', port);
    const reply = await client.waitFor(/(?:^|\n)Good Bye\n/);
    assert.equal(reply, 'Y\nGood Bye\n');
  });
});
