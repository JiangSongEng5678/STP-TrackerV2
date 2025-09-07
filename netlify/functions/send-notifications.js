// netlify/functions/send-notifications.js
const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

webpush.setVapidDetails('mailto:you@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

exports.handler = async function() {
  const now = new Date().toISOString();
  const { data: reminders, error } = await supabase
    .from('reminders')
    .select('id, user_id, title, body, url, fire_at, sent')
    .lte('fire_at', now)
    .eq('sent', false)
    .limit(500);
  if (error) return { statusCode: 500, body: 'DB error' };
  if (!reminders || reminders.length === 0) return { statusCode: 200, body: 'ok' };

  const users = [...new Set(reminders.map(r => r.user_id))];
  const { data: subs } = await supabase
    .from('push_subscriptions')
    .select('user_id, endpoint, p256dh, auth')
    .in('user_id', users);

  const subsByUser = new Map();
  (subs || []).forEach(s => {
    if (!subsByUser.has(s.user_id)) subsByUser.set(s.user_id, []);
    subsByUser.get(s.user_id).push(s);
  });

  const toDelete = []; const toMark = [];
  await Promise.all(reminders.map(async r => {
    const targets = subsByUser.get(r.user_id) || [];
    const payload = JSON.stringify({ title: r.title, body: r.body, url: r.url || '/' });
    await Promise.all(targets.map(async s => {
      try {
        await webpush.sendNotification({
          endpoint: s.endpoint,
          keys: { p256dh: s.p256dh, auth: s.auth }
        }, payload);
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) toDelete.push(s.endpoint);
        console.error('push error', err.statusCode, err.body);
      }
    }));
    toMark.push(r.id);
  }));

  if (toDelete.length) await supabase.from('push_subscriptions').delete().in('endpoint', toDelete);
  if (toMark.length) await supabase.from('reminders').update({ sent: true }).in('id', toMark);

  return { statusCode: 200, body: 'ok' };
};
