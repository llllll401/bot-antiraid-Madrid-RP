const { Client, GatewayIntentBits, Partials, AuditLogEvent, PermissionsBitField } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');

const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (!config.token || /^(COLLER_|REMPLACER_|YOUR_)/i.test(config.token)) throw new Error('Renseignez le vrai token du bot dans config.json');
if (!/^\d{17,20}$/.test(config.guildId || '')) throw new Error('Renseignez un guildId Discord valide dans config.json');
const guildId = config.guildId;
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildModeration], partials: [Partials.Message, Partials.Channel] });
const buckets = new Map();
const userMessages = new Map();
const warned = new Map();

function exempt(member) {
  return !member || member.id === member.guild.ownerId || member.user?.bot ||
    config.whitelist.userIds.includes(member.id) || member.roles?.cache?.some(r => config.whitelist.roleIds.includes(r.id));
}
function record(key, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now); buckets.set(key, arr); return arr.length;
}
function limit(name) { return config.limits[name]; }
async function log(guild, text) {
  if (!config.logChannelId) return;
  const ch = await guild.channels.fetch(config.logChannelId).catch(() => null);
  if (ch?.isTextBased()) await ch.send({ content: text }).catch(() => {});
}
async function auditExecutor(guild, type, targetId) {
  const logs = await guild.fetchAuditLogs({ type, limit: 6 }).catch(() => null);
  const entry = logs?.entries.find(e => String(e.targetId || '') === String(targetId) && Date.now() - e.createdTimestamp < 15000);
  return entry?.executor || null;
}
async function punish(member, action, duration, reason) {
  if (!member || exempt(member)) return;
  try {
    if (action === 'quarantine' && config.quarantineRoleId) {
      await member.roles.add(config.quarantineRoleId, reason); return;
    }
    if (action === 'removeRoles') {
      const removable = member.roles.cache.filter(r => r.id !== member.guild.id && r.editable);
      if (removable.size) await member.roles.remove(removable, reason);
      const ms = config.actions.raidTimeoutMs;
      if (member.moderatable && ms) await member.timeout(ms, reason);
      return;
    }
    if (action === 'timeout' && member.moderatable) await member.timeout(duration || 600000, reason);
  } catch (e) { console.error(`Sanction impossible (${member.id}):`, e.message); }
}
async function counterGuard(guild, executor, counter, reason) {
  if (!executor || !executor.id || executor.bot) return;
  const member = await guild.members.fetch(executor.id).catch(() => null);
  if (exempt(member)) return;
  await punish(member, config.actions.onDestructiveRaid, 0, `Anti-raid : ${reason}`);
  await log(guild, `🚨 **Anti-raid** — ${executor.tag} (${executor.id}) : ${reason}. Action : ${config.actions.onDestructiveRaid}.`);
}
async function guardEvent(guild, targetId, auditType, key, reason) {
  if (!guild || guild.id !== guildId) return;
  const exec = await auditExecutor(guild, auditType, targetId);
  if (!exec || exempt(await guild.members.fetch(exec.id).catch(() => null))) return;
  const cfg = limit(key); if (!cfg || record(`${guild.id}:${key}:${exec.id}`, cfg.windowMs) < cfg.count) return;
  await counterGuard(guild, exec, key, reason);
}

client.once('ready', () => console.log(`Connecté en tant que ${client.user.tag} — serveur ${guildId}`));
client.on('guildMemberAdd', async member => {
  if (member.guild.id !== guildId) return;
  const cfg = limit('joins');
  if (record(`${guildId}:joins`, cfg.windowMs) >= cfg.count) {
    await punish(member, config.actions.onRaidJoin, 0, 'Arrivées groupées détectées');
    await log(member.guild, `🚨 Vague d'arrivées détectée (${cfg.count} en ${cfg.windowMs / 1000}s). ${member.user.tag} (${member.id}) traité.`);
  }
});
client.on('messageCreate', async message => {
  if (!message.guild || message.guild.id !== guildId || message.author.bot || !message.member || exempt(message.member)) return;
  if (config.spam.ignoredChannelIds.includes(message.channelId)) return;
  const settings = limit('messages'); const key = `${message.guild.id}:${message.author.id}`; const now = Date.now();
  const list = (userMessages.get(key) || []).filter(x => now - x.time < settings.windowMs);
  list.push({ time: now, content: message.content.toLowerCase().trim(), id: message.id }); userMessages.set(key, list);
  const repeated = list.filter(x => x.content && x.content === message.content.toLowerCase().trim()).length;
  const tooManyFiles = message.attachments.size > config.spam.maxAttachments;
  const spam = list.length >= settings.count || repeated >= limit('repeatedMessages').count || tooManyFiles;
  if (!spam) {
    if (list.length === config.spam.warnAt && !warned.has(key)) {
      warned.set(key, now); await message.reply('⚠️ Ralentis le rythme de tes messages.').catch(() => {});
    }
    return;
  }
  if (config.spam.deleteMessages) await Promise.all(list.map(x => message.channel.messages.delete(x.id).catch(() => {})));
  const duration = config.actions.spamTimeoutMs;
  await punish(message.member, config.actions.onSpam, duration, 'Spam détecté');
  await log(message.guild, `🛡️ Spam détecté : ${message.author.tag} (${message.author.id}) dans <#${message.channelId}>. ${list.length} messages en ${settings.windowMs / 1000}s.`);
  userMessages.delete(key); warned.delete(key);
});
client.on('channelDelete', ch => guardEvent(ch.guild, ch.id, AuditLogEvent.ChannelDelete, 'channelDeletes', 'suppressions massives de salons'));
client.on('channelCreate', ch => guardEvent(ch.guild, ch.id, AuditLogEvent.ChannelCreate, 'channelCreates', 'créations massives de salons'));
client.on('roleDelete', role => guardEvent(role.guild, role.id, AuditLogEvent.RoleDelete, 'roleDeletes', 'suppressions massives de rôles'));
client.on('roleCreate', role => guardEvent(role.guild, role.id, AuditLogEvent.RoleCreate, 'roleCreates', 'créations massives de rôles'));
client.on('guildBanAdd', ban => guardEvent(ban.guild, ban.user.id, AuditLogEvent.MemberBanAdd, 'bans', 'bannissements massifs'));
client.on('guildMemberRemove', async member => {
  if (member.guild.id !== guildId) return;
  const exec = await auditExecutor(member.guild, AuditLogEvent.MemberKick, member.id);
  if (!exec) return;
  const cfg = limit('kicks'); if (record(`${guildId}:kicks:${exec.id}`, cfg.windowMs) >= cfg.count) await counterGuard(member.guild, exec, 'kicks', 'expulsions massives');
});
client.on('guildMemberUpdate', async (oldM, newM) => {
  if (newM.guild.id !== guildId || oldM.communicationDisabledUntilTimestamp === newM.communicationDisabledUntilTimestamp || !newM.communicationDisabledUntilTimestamp) return;
  const exec = await auditExecutor(newM.guild, AuditLogEvent.MemberUpdate, newM.id);
  if (!exec) return;
  const cfg = limit('timeouts'); if (record(`${guildId}:timeouts:${exec.id}`, cfg.windowMs) >= cfg.count) await counterGuard(newM.guild, exec, 'timeouts', 'timeouts massifs');
});
client.on('error', e => console.error('Discord client error:', e));
process.on('unhandledRejection', e => console.error('Erreur asynchrone:', e));
client.login(config.token);
