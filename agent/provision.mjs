#!/usr/bin/env node
/**
 * OpenForge droplet provisioner — spin up a real cloud micro-server
 * hosting the agent companion, on demand.
 *
 *   DIGITALOCEAN_TOKEN=… node agent/provision.mjs
 *   DIGITALOCEAN_TOKEN=… node agent/provision.mjs --destroy <droplet-id>
 *
 * The droplet boots from a cloud-init script that installs Node 20,
 * clones this repository, and runs agent/server.mjs on port 8737 with a
 * generated token. Output is JSON: { dropletId, ip, url, token } — paste
 * url + token into the workbench's Companion settings. (From the HTTPS
 * workbench page, reach it over a Tailscale HTTPS name or a tunnel — the
 * printed http:// URL works for API-level checks and local tooling.)
 *
 * Provider notes: DigitalOcean is implemented (no free tier — the
 * smallest droplet is a few dollars a month and can be destroyed in one
 * command). The same cloud-init works unchanged on Hetzner/Vultr VMs and
 * on Oracle Cloud Always Free instances created by hand.
 *
 * Env: DIGITALOCEAN_TOKEN (required), DO_API_BASE (testing override),
 * DO_REGION (default nyc3), DO_SIZE (default s-1vcpu-1gb), REPO_URL,
 * COMPANION_TOKEN (generated when unset), COMPANION_HEALTH_URL (testing
 * override for the post-boot health poll).
 */

import { randomUUID } from 'node:crypto';

const API = (process.env.DO_API_BASE || 'https://api.digitalocean.com/v2').replace(/\/$/, '');
const token = process.env.DIGITALOCEAN_TOKEN;
if (!token) { console.error('DIGITALOCEAN_TOKEN is required.'); process.exit(2); }

async function api(route, init = {}) {
  const response = await fetch(`${API}${route}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  if (!response.ok) throw new Error(`DigitalOcean API ${route} failed (${response.status}): ${(await response.text()).slice(0, 240)}`);
  return response.status === 204 ? null : response.json();
}

const destroyIndex = process.argv.indexOf('--destroy');
if (destroyIndex >= 0) {
  const id = process.argv[destroyIndex + 1];
  await api(`/droplets/${id}`, { method: 'DELETE' });
  console.log(JSON.stringify({ destroyed: id }));
  process.exit(0);
}

const repoUrl = process.env.REPO_URL || 'https://github.com/Etienne0101-lab/OpenForge-Workbench-.git';
const companionToken = process.env.COMPANION_TOKEN || randomUUID();
const userData = `#!/bin/bash
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
git clone ${repoUrl} /opt/openforge
cd /opt/openforge/agent
nohup node server.mjs --host 0.0.0.0 --port 8737 --token ${companionToken} --root /opt/openforge-workspaces > /var/log/openforge-companion.log 2>&1 &
`;

const created = await api('/droplets', {
  method: 'POST',
  body: JSON.stringify({
    name: `openforge-agent-${Date.now().toString(36)}`,
    region: process.env.DO_REGION || 'nyc3',
    size: process.env.DO_SIZE || 's-1vcpu-1gb',
    image: 'ubuntu-24-04-x64',
    user_data: userData,
    tags: ['openforge', 'agent-companion'],
  }),
});
const droplet = created.droplet;
console.log(`Droplet ${droplet.id} created — waiting for it to boot…`);

let ip = null;
for (let attempt = 0; attempt < 40 && !ip; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 6000));
  const current = await api(`/droplets/${droplet.id}`);
  const v4 = current.droplet.networks?.v4?.find((network) => network.type === 'public');
  if (current.droplet.status === 'active' && v4) ip = v4.ip_address;
}
if (!ip) { console.error('Droplet did not come up with a public IP in ~4 minutes. Check the DigitalOcean console.'); process.exit(1); }

const healthUrl = process.env.COMPANION_HEALTH_URL || `http://${ip}:8737/health`;
let healthy = false;
for (let attempt = 0; attempt < 30 && !healthy; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 6000));
  try { const response = await fetch(healthUrl); healthy = response.ok; } catch { /* still booting */ }
}
console.log(JSON.stringify({ dropletId: droplet.id, ip, url: `http://${ip}:8737`, token: companionToken, companionHealthy: healthy }, null, 2));
if (!healthy) console.error('Note: the companion health check has not answered yet — cloud-init may still be installing Node. Give it another minute, then check http://<ip>:8737/health.');
