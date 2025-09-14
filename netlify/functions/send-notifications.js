// netlify/functions/send-notifications.js
const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

// Suppress only the noisy Node 'punycode' deprecation warning
process.on('warning', (w) => {
  if (w && w.name === 'DeprecationWarning' && /punycode/i.test(String(w.message))) return;
  console.warn(w.stack || w.message || w);
});

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

webpush.setVapidDetails('mailto:you@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

exports.handler = async function() {
  const start = Date.now();
  try {
    const now = new Date().toISOString();
    const { data: reminders, error } = await supabase
      .from('reminders')
      .select('id, user_id, title, body, url, fire_at, sent')
      .lte('fire_at', now)
      .eq('sent', false)
      .limit(500);

    if (error) {
      console.error('DB error selecting reminders:', error);
      return { statusCode: 500, body: 'DB error' };
    }
    if (!reminders || reminders.length === 0) {
      console.log('No due reminders at', now);
      // Also do periodic cleanup when idle
      await cleanupOld();
      return { statusCode: 200, body: 'ok' };
    }

    const users = [...new Set(reminders.map(r => r.user_id))];
    const { data: subs, error: subErr } = await supabase
      .from('push_subscriptions')
      .select('user_id, endpoint, p256dh, auth')
      .in('user_id', users);

    if (subErr) {
      console.error('DB error selecting subscriptions:', subErr);
      return { statusCode: 500, body: 'DB error' };
    }

    const subsByUser = new Map();
    (subs || []).forEach(s => {
      if (!subsByUser.has(s.user_id)) subsByUser.set(s.user_id, []);
      subsByUser.get(s.user_id).push(s);
    });

    const toDelete = []; const toMark = [];
    let sentCount = 0; let targetCount = 0;

    await Promise.all(reminders.map(async r => {
      const targets = subsByUser.get(r.user_id) || [];
      targetCount += targets.length;
      const payload = JSON.stringify({ title: r.title, body: r.body, url: r.url || '/' });

      await Promise.all(targets.map(async s => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload
          );
          sentCount++;
        } catch (err) {
          const code = err && (err.statusCode || err.status);
          if (code === 404 || code === 410) toDelete.push(s.endpoint); // expired
          console.error('push error', code, err && err.body ? err.body : String(err));
        }
      }));

      toMark.push(r.id);
    }));

    if (toDelete.length) {
      await supabase.from('push_subscriptions').delete().in('endpoint', toDelete);
      console.log('Deleted expired subscriptions:', toDelete.length);
    }
    if (toMark.length) {
      await supabase.from('reminders').update({ sent: true }).in('id', toMark);
      console.log('Marked reminders sent:', toMark.length);
    }

    console.log(`Done. Reminders: ${reminders.length}, Targets: ${targetCount}, Sent: ${sentCount}, Duration: ${Date.now()-start}ms`);
    await cleanupOld(); // space saver

    return { statusCode: 200, body: 'ok' };
  } catch (e) {
    console.error('Unhandled error in function:', e);
    return { statusCode: 500, body: 'error' };
  }
};

// delete sent reminders older than 30 days
async function cleanupOld(days = 30) {
  const cutoff = new Date(Date.now() - days*24*60*60*1000).toISOString();
  const { error } = await supabase
    .from('reminders')
    .delete()
    .eq('sent', true)
    .lte('fire_at', cutoff);
  if (error) console.error('Cleanup error:', error);
}
