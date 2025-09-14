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

    // === IMPORTANT: fan-out to ALL devices for each user ===
    const users = [...new Set(reminders.map(r => r.user_id))];
    const { data: subs, error: subErr } = await supabase
      .from('push_subscriptions')
      .select('user_id, endpoint, p256dh, auth')
      .in('user_id', users);

    if (subErr) {
      console.error('DB error selecting subscriptions:', subErr);
      return { statusCode: 500, body: 'DB error' };
    }

    // Group subs per user and dedupe by endpoint to be safe
    const subsByUser = new Map();
    (subs || []).forEach(s => {
      const list = subsByUser.get(s.user_id) || [];
      if (!list.find(x => x.endpoint === s.endpoint)) list.push(s);
      subsByUser.set(s.user_id, list);
    });

    const toDelete = [];     // expired endpoints to remove
    const toMarkSent = [];   // reminder ids that had >=1 successful delivery
    let sentCount = 0; 
    let targetCount = 0;

    // Send to every device for each user's reminder
    await Promise.all(reminders.map(async r => {
      const targets = subsByUser.get(r.user_id) || [];
      targetCount += targets.length;
      if (targets.length === 0) return;  // Don't mark as sent if user has no devices

      const payload = JSON.stringify({ title: r.title, body: r.body, url: r.url || '/' });
      let okForThisReminder = 0;

      await Promise.all(targets.map(async s => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload
          );
          sentCount++;
          okForThisReminder++;
        } catch (err) {
          const code = err && (err.statusCode || err.status);
          if (code === 404 || code === 410) toDelete.push(s.endpoint); // expired
          console.error('push error', code, err && err.body ? err.body : String(err));
        }
      }));

      if (okForThisReminder > 0) {
        toMarkSent.push(r.id);
      }
    }));

    if (toDelete.length) {
      await supabase.from('push_subscriptions').delete().in('endpoint', toDelete);
      console.log('Deleted expired subscriptions:', toDelete.length);
    }
    if (toMarkSent.length) {
      await supabase.from('reminders').update({ sent: true }).in('id', toMarkSent);
      console.log('Marked reminders sent:', toMarkSent.length);
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
