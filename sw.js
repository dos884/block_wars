// Cube Wars service worker: only notifications, no offline caching (so a deploy is never hidden behind old files).
// Pushes carry no data: on each one, ask the server what's new and show the most useful notification.
'use strict';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

async function token() {
  const r = await (await caches.open('bw')).match('/__token');   // the page puts the player's token here
  return r ? r.text() : null;
}
async function onPush() {
  let title = 'Cube Wars', body = 'Something happened in one of your games.', url = '/', tag = 'bw';
  try {
    const t = await token();
    const me = await (await fetch('/api/me', { headers: { authorization: 'Bearer ' + t } })).json();
    const live = (me.games || []).filter(g => g.winner < 0).sort((a, b) => b.updated - a.updated);
    const turn = live.find(g => g.myTurn), fresh = live[0];
    if (turn) {
      title = 'Your turn';
      body = turn.opponent ? turn.opponent + ' made their move.' : 'Your move.';
      url = '/?m=' + turn.id; tag = 'turn-' + turn.id;
    } else if (fresh && fresh.turns === 0) {
      title = 'Opponent found';
      body = (fresh.opponent || 'Someone') + ' is playing Blue and moves first.';
      url = '/?m=' + fresh.id; tag = 'turn-' + fresh.id;
    }
  } catch { /* offline or signed out: the generic text will do */ }
  return self.registration.showNotification(title, { body, tag, renotify: true, icon: '/icon-192.png', badge: '/icon-192.png', data: { url } });
}
self.addEventListener('push', e => e.waitUntil(onPush()));

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const same = wins.find(w => w.url === url);
    if (same) return same.focus();
    if (wins[0] && 'navigate' in wins[0]) { await wins[0].focus(); return wins[0].navigate(url); }
    return self.clients.openWindow(url);
  })());
});
