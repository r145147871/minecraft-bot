// index.js
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalBlock } = goals;
const mcDataLib = require('minecraft-data');
const express = require('express');
const fs = require('fs');
const path = require('path');

const settingsPath = path.join(__dirname, 'settings.json');
if (!fs.existsSync(settingsPath)) {
  console.error('settings.json not found! Create one based on example and restart.');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

// Basic Express server for UptimeRobot / keepalive
const app = express();
app.get('/', (req, res) => res.send('Bot has arrived'));
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));

let botInstance = null;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function createBot() {
  console.log('\n[AfkBot] Creating bot...');
  const bot = mineflayer.createBot({
    username: config['bot-account'].username || 'ServerBot',
    password: config['bot-account'].password || undefined,
    auth: config['bot-account'].type || 'mojang',
    host: config.server.ip,
    port: config.server.port,
    version: config.server.version || false,
  });

  bot.loadPlugin(pathfinder);
  const mcData = mcDataLib(bot.version);
  const defaultMove = new Movements(bot, mcData);
  bot.settings.colorsEnabled = false;

  bot.once('spawn', async () => {
    console.log('\x1b[33m[AfkBot] Bot joined the server\x1b[0m');

    // auto-auth
    if (config.utils && config.utils['auto-auth'] && config.utils['auto-auth'].enabled) {
      console.log('[INFO] Started auto-auth module');
      const password = String(config.utils['auto-auth'].password || '');

      try {
        await performAuthSequence(bot, password);
        console.log('[INFO] Auth sequence finished.');
      } catch (err) {
        console.error('[ERROR] Auth sequence failed:', err);
      }
    }

    // chat messages
    if (config.utils && config.utils['chat-messages'] && config.utils['chat-messages'].enabled) {
      console.log('[INFO] Started chat-messages module');
      const messages = config.utils['chat-messages'].messages || [];
      if (config.utils['chat-messages'].repeat) {
        const delay = (config.utils['chat-messages']['repeat-delay'] || 120) * 1000;
        let i = 0;
        setInterval(() => {
          if (messages.length === 0) return;
          bot.chat(messages[i]);
          i = (i + 1) % messages.length;
        }, delay);
      } else {
        for (const m of messages) if (m && m.length) bot.chat(m);
      }
    }

    // position pathfinder
    const pos = config.position || {};
    if (pos.enabled) {
      console.log(`[Afk Bot] Moving to ${pos.x}, ${pos.y}, ${pos.z}`);
      bot.pathfinder.setMovements(defaultMove);
      bot.pathfinder.setGoal(new GoalBlock(pos.x, pos.y, pos.z));
    }

    // anti-afk
    if (config.utils && config.utils['anti-afk'] && config.utils['anti-afk'].enabled) {
      bot.setControlState('jump', true);
      if (config.utils['anti-afk'].sneak) bot.setControlState('sneak', true);
    }
  });

  // general chat logging if enabled
  if (config.utils && config.utils['chat-log']) {
    bot.on('chat', (username, message) => {
      console.log(`[ChatLog] <${username}> ${message}`);
    });
  }

  bot.on('goal_reached', () => {
    try {
      console.log(`[AfkBot] Goal reached at ${bot.entity.position}`);
    } catch (e) {}
  });

  bot.on('death', () => {
    try {
      console.log(`[AfkBot] Bot died and respawned at ${bot.entity.position}`);
    } catch (e) {}
  });

  bot.on('kicked', (reason) => {
    console.log('\x1b[33m', `[AfkBot] Bot was kicked. Reason:\n${reason}`, '\x1b[0m');
  });

  bot.on('error', (err) => {
    console.log(`\x1b[31m[ERROR] ${err.message}\x1b[0m`);
  });

  bot.on('end', () => {
    console.log('\x1b[33m[AfkBot] Connection ended. Reconnecting...\x1b[0m');
    botInstance = null;
    if (config.utils && config.utils['auto-reconnect']) {
      const delay = config.utils['auto-recconect-delay'] || 10000;
      setTimeout(() => {
        createBot();
      }, delay);
    }
  });

  botInstance = bot;
  return bot;
}

/**
 * performAuthSequence:
 * - Listens to chat for common messages from LoginSecurity / Auth plugins
 * - Sends register, then login (with delays)
 * - Retries a few times if no response
 */
async function performAuthSequence(bot, password) {
  if (!bot || !bot._client) throw new Error('Bot not ready');

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`[Auth] Attempt ${attempt} of ${maxAttempts}`);

    // temporary state to resolve when we detect a login success
    let resolved = false;

    const onChat = (username, message) => {
      const m = (message || '').toLowerCase();
      // registration messages
      if (m.includes('successfully registered') || m.includes('you have registered') || m.includes('registered successfully')) {
        console.log('[Auth] Server: registration confirmed.');
        // send login shortly after
        setTimeout(() => {
          console.log('[Auth] Sending /login command (after register).');
          bot.chat(`/login ${password}`);
        }, 1000);
      } else if (m.includes('already registered') || m.includes('is already registered')) {
        console.log('[Auth] Server: already registered -> will attempt login.');
        setTimeout(() => {
          console.log('[Auth] Sending /login command (already registered).');
          bot.chat(`/login ${password}`);
        }, 800);
      } else if (m.includes('successfully logged in') || m.includes('logged in') || m.includes('you are now logged in') || m.includes('login successful')) {
        console.log('[INFO] Login successful.');
        resolved = true;
      } else if (m.includes('invalid password') || m.includes('wrong password') || m.includes('incorrect password')) {
        console.error('[ERROR] Login failed: invalid password.');
        resolved = true; // stop waiting; user must fix password
      } else if (m.includes('not registered') || m.includes('you are not registered')) {
        // server telling it's not registered -> we will register again next loop
        console.log('[Auth] Server: not registered -> will attempt register.');
      }
    };

    bot.on('chat', onChat);

    // send register first (some plugins ignore if already registered)
    try {
      console.log('[Auth] Sending /register command.');
      bot.chat(`/register ${password} ${password}`);
    } catch (e) {
      console.error('[Auth] Error sending /register:', e.message);
    }

    // wait then send login
    await sleep(2000);
    try {
      console.log('[Auth] Sending /login command (initial).');
      bot.chat(`/login ${password}`);
    } catch (e) {
      console.error('[Auth] Error sending /login:', e.message);
    }

    // wait up to X seconds for a success/invalid message
    const waitMs = 8000;
    const start = Date.now();
    while (!resolved && Date.now() - start < waitMs) {
      await sleep(300);
    }

    bot.removeListener('chat', onChat);

    if (resolved) {
      // if resolved by success or invalid password, break
      // check console for "Login successful." vs "invalid password"
      // We assume that if "Login successful." printed earlier it's OK.
      // To be safe, wait a small moment for any final messages.
      await sleep(500);
      return;
    }

    console.log(`[Auth] Attempt ${attempt} did not confirm success; retrying...`);
    await sleep(1500);
  }

  console.warn('[Auth] All auth attempts finished. If not logged in check password or plugin messages in chat.');
}

// start
createBot();
