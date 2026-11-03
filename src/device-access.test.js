import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const guard = readFileSync(new URL('../public/device-access.js', import.meta.url), 'utf8');
function visit({ userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', mobile = false, touch = 0, platform = 'Win32', width = 1920, height = 1080, pathname = '/Chord-Shift/index.html', search = '?page=melody&home=old-phone-link' } = {}) {
  const result = { redirect: null, classes: [] };
  runInNewContext(guard, {
    navigator: { userAgent, userAgentData: { mobile }, maxTouchPoints: touch, platform },
    screen: { width, height }, URLSearchParams,
    document: { documentElement: { classList: { add: name => result.classes.push(name) } } },
    location: { pathname, search, replace: value => { result.redirect = value; } },
  });
  return result;
}

test('phone links to Melody redirect to Chord Shift and remove server-link parameters', () => {
  for (const device of [
    { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' },
    { userAgent: 'Mozilla/5.0 (Linux; Android 15) Mobile' },
    { mobile: true },
    // A phone requesting the desktop site can still be recognized by touch and screen size.
    { touch: 5, width: 390, height: 844 },
  ]) {
    assert.deepEqual(visit(device), { redirect: './chords.html', classes: ['phone-device'] });
  }
});

test('phones stay on Chord Shift and desktop computers keep Melody access', () => {
  assert.deepEqual(visit({ mobile: true, pathname: '/Chord-Shift/chords.html' }), { redirect: null, classes: ['phone-device'] });
  assert.deepEqual(visit(), { redirect: null, classes: [] });
  assert.equal(visit({ width: 390, height: 844 }).redirect, null);
  assert.equal(visit({ touch: 10 }).redirect, null);
});

test('default entry still opens Chord Shift on both devices', () => {
  assert.equal(visit({ pathname: '/Chord-Shift/', search: '' }).redirect, './chords.html');
  assert.equal(visit({ pathname: '/', mobile: true }).redirect, './chords.html');
});
