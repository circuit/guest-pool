'use strict';
const fetch = require('node-fetch');
const express = require('express');
const simpleOauth2 = require('simple-oauth2');
const config = require('./config.json');

const app = express();
app.use(express.json());

const HOST = process.env.host || config.host;
const PORT = process.env.port || config.port || 8080;
const HOOK_URL = '/webhook2';

const webhookSubscriptions = {};

// Presence for each user per domain
/*
  presence = {
    circuitsandbox.net: {
      <userId1>: 'AVAILABLE',
      <userId2>: 'BUSY',
    }
  }
*/
const presence = {};

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

app.post(HOOK_URL, (req, res) => {
  const domain = webhookSubscriptions[req.body.webhookId];
  const {userId, state} = req.body.presenceState;

  console.log(`State change for ${userId} from ${presence[domain][userId]} to ${state}`);
  presence[domain][userId] = state;
});

app.get('/token', (req, res) => {
  const clientId = req.query.clientId;
  if (!clientId) {
    res.status(500).send('clientId is missing');
    return;
  }
  const domain = req.query.domain;
  if (!domain) {
    res.status(500).send('domain is missing');
    return;
  }

  // Look up pool for clientId
  const pool = config[domain].pools.find(p => p.clientId === clientId);
  if (!pool) {
    res.status(500).send(`no pool found for clientId ${clientId}`);
    return;
  }

  // Find available user
  const user = pool.users.find(user => presence[domain][user.userId] === 'AVAILABLE');
  res.json({token: user && user.token});
});

app.listen(PORT, () => console.log('App listening on: ', PORT));


async function init(domain) {
  const {credentials: cred, pools} = config[domain];

  const oauth2 = simpleOauth2.create({
    client: {
      id: cred.clientId,
      secret: cred.clientSecret
    },
    auth: {
      tokenHost: `https://${domain}`
    }
  });
  const { access_token: token } = await oauth2.clientCredentials.getToken({scope: 'ALL'});
  cred.token = token;

  // Clear all previous webhooks created for this domain
  await fetch(`https://${domain}/rest/webhooks`, {
    method: 'DELETE',
    headers: { 'Authorization': 'Bearer ' + token }
  });

  const userIds2D = pools.map(pool => pool.users.map(user => user.userId));
  const userIds = [...new Set([].concat(...userIds2D))];

  // Subscribe to presence changes
  let res = await fetch(`https://${domain}/rest/webhooks/presence`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token
    },
    body: JSON.stringify({
      url: `${HOST}${HOOK_URL}`,
      userIds: userIds
    })
  });
  res = await res.json();
  webhookSubscriptions[res.id] = domain;

  // Get current presence state
  res = await fetch(`https://${domain}/rest/users/presence?userIds=${userIds.join(',')}`, {
    headers: { 'Authorization': 'Bearer ' + token }
  });
  res = await res.json();
  presence[domain] = {};
  res.forEach(u => presence[domain][u.userId] = u.state);
}

(async () => {
  try {
    for (let domain of Object.keys(config)) {
      await init(domain);
    }
  } catch (err) {
    console.error(err);
  }
})();