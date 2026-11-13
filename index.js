const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder, GatewayIntentBits,
  ModalBuilder, TextInputBuilder, TextInputStyle, UserSelectMenuBuilder,
  RoleSelectMenuBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder
} = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (!config.token || /^(COLLER_|REMPLACER_|YOUR_)/i.test(config.token)) throw new Error('Renseignez le vrai token dans config.json');
if (!/^\d{17,20}$/.test(config.guildId || '')) throw new Error('Renseignez un guildId Discord valide dans config.json');
for (const field of ['absenceBoardChannelId', 'absenceRequestChannelId', 'absenceReviewChannelId', 'sanctionPanelChannelId', 'sanctionLogChannelId']) {
  if (!/^\d{17,20}$/.test(config[field] || '')) throw new Error(`Renseignez ${field} dans config.json`);
}
for (const key of ['warn1', 'warn2', 'suspension3Days']) {
  if (!/^\d{17,20}$/.test(config.sanctionRoles?.[key] || '')) throw new Error(`Renseignez sanctionRoles.${key} dans config.json`);
}
if (new Set(Object.values(config.sanctionRoles)).size !== 3) throw new Error('Chaque sanction doit avoir un ID de rôle différent.');
const sanctionDurations = config.sanctionDurationsDays || { warn1: 7, warn2: 7, suspension3Days: 3 };
for (const key of ['warn1', 'warn2', 'suspension3Days']) {
  if (!Number.isFinite(sanctionDurations[key]) || sanctionDurations[key] <= 0 || sanctionDurations[key] > 3650) throw new Error(`Durée invalide pour ${key} dans config.json`);
}
const guildId = config.guildId;
const statePath = path.join(__dirname, 'absences.json');
const timezone = config.timezone || 'Europe/Paris';
const dateFormatter = new Intl.DateTimeFormat('fr-FR', {
  timeZone: timezone, day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

function emptyState() { return { boardMessageId: null, requestPanelMessageId: null, sanctionPanelMessageId: null, absences: [], sanctions: [] }; }
function isSnowflake(value) { return typeof value === 'string' && /^\d{17,20}$/.test(value); }
function loadState() {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    const backupPath = `${statePath}.corrupt-${Date.now()}`;
    try { fs.renameSync(statePath, backupPath); } catch {}
    console.error(`Le fichier d’absences est illisible; copie de secours: ${backupPath}`, error.message);
    return emptyState();
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.absences)) {
    const backupPath = `${statePath}.corrupt-${Date.now()}`;
    try { fs.renameSync(statePath, backupPath); } catch {}
    console.error(`Format de ${statePath} invalide; fichier sauvegardé sous ${backupPath}.`);
    return emptyState();
  }
  const absences = parsed.absences.filter(a => a && typeof a === 'object' && typeof a.id === 'string' &&
    isSnowflake(a.userId) && typeof a.reason === 'string' && Number.isFinite(a.startAt) && Number.isFinite(a.endAt) &&
    a.endAt > a.startAt && ['pending', 'approved', 'rejected'].includes(a.status));
  const rawSanctions = Array.isArray(parsed.sanctions) ? parsed.sanctions : [];
  const sanctions = rawSanctions.filter(s => s && typeof s === 'object' && typeof s.id === 'string' &&
    isSnowflake(s.userId) && isSnowflake(s.moderatorId) && typeof s.reason === 'string' &&
    ['warn1', 'warn2', 'suspension3Days'].includes(s.type) && ['active', 'expired', 'cleared', 'failed'].includes(s.status) &&
    Number.isFinite(s.issuedAt) && Number.isFinite(s.expiresAt) && s.expiresAt > s.issuedAt);
  if (absences.length !== parsed.absences.length || sanctions.length !== rawSanctions.length) console.warn('Certaines entrées invalides de absences.json ont été ignorées.');
  return {
    boardMessageId: isSnowflake(parsed.boardMessageId) ? parsed.boardMessageId : null,
    requestPanelMessageId: isSnowflake(parsed.requestPanelMessageId) ? parsed.requestPanelMessageId : null,
    sanctionPanelMessageId: isSnowflake(parsed.sanctionPanelMessageId) ? parsed.sanctionPanelMessageId : null,
    absences, sanctions
  };
}
const state = loadState();
function saveState() {
  const tmp = `${statePath}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'w', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, statePath);
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}
function dateParts(timestamp) {
  return Object.fromEntries(dateFormatter.formatToParts(new Date(timestamp)).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
}
function toTimestamp(input) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/.exec(input.trim());
  if (!match) throw new Error('Format attendu : JJ/MM/AAAA HH:MM (ex. 05/11/2026 14:30).');
  const [, dd, mm, yyyy, hh, min] = match.map(Number);
  const naive = Date.UTC(yyyy, mm - 1, dd, hh, min);
  const calendar = new Date(naive);
  if (calendar.getUTCFullYear() !== yyyy || calendar.getUTCMonth() !== mm - 1 || calendar.getUTCDate() !== dd || hh > 23 || min > 59) {
    throw new Error('Date ou heure invalide.');
  }
  const wanted = { day: dd, month: mm, year: yyyy, hour: hh, minute: min };
  let guess = naive;
  for (let i = 0; i < 4; i++) {
    const p = dateParts(guess);
    const representedAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess = naive - (representedAsUtc - guess);
  }
  const actual = dateParts(guess);
  if (Object.keys(wanted).some(key => wanted[key] !== actual[key])) throw new Error(`Cette date/heure n’existe pas dans le fuseau ${timezone} (changement d’heure).`);
  return guess;
}
function displayDate(timestamp) { return dateFormatter.format(new Date(timestamp)); }
function safeText(value, max = 500) { return String(value || '').replace(/@/g, '@\u200b').slice(0, max); }
function createPanelEmbed() {
  return new EmbedBuilder().setColor(0x5865f2).setTitle('Déclarer une absence')
    .setDescription('Clique sur le bouton ci-dessous puis indique le motif, la date et l’heure de départ et de retour. Les dates sont au format **JJ/MM/AAAA HH:MM** (heure locale du serveur).')
    .setFooter({ text: 'Une demande sera envoyée au salon de validation.' });
}
function createPanelRow() {
  return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('absence:create').setLabel('Créer une demande d’absence').setStyle(ButtonStyle.Primary));
}
function createRequestModal() {
  return new ModalBuilder().setCustomId('absence:submit').setTitle('Demande d’absence').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Motif de l’absence').setStyle(TextInputStyle.Paragraph).setMaxLength(800).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('start').setLabel('Départ (JJ/MM/AAAA HH:MM)').setPlaceholder('05/11/2026 14:30').setStyle(TextInputStyle.Short).setMaxLength(16).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('end').setLabel('Retour (JJ/MM/AAAA HH:MM)').setPlaceholder('08/11/2026 18:00').setStyle(TextInputStyle.Short).setMaxLength(16).setRequired(true))
  );
}
function formatReviewEmbed(absence) {
  return new EmbedBuilder().setColor(absence.status === 'pending' ? 0xf1c40f : absence.status === 'approved' ? 0x2ecc71 : 0xe74c3c)
    .setTitle(absence.status === 'pending' ? 'Demande d’absence à traiter' : `Demande ${absence.status === 'approved' ? 'acceptée' : 'refusée'}`)
    .setDescription(`**Personne :** <@${absence.userId}>\n**Motif :** ${safeText(absence.reason)}\n**Départ :** ${displayDate(absence.startAt)}\n**Retour :** ${displayDate(absence.endAt)}${absence.decisionReason ? `\n**Motif du refus :** ${safeText(absence.decisionReason)}` : ''}`)
    .setFooter({ text: `Demande ${absence.id}` }).setTimestamp(absence.createdAt);
}
function reviewButtons(absence) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`absence:approve:${absence.id}`).setLabel('Accepter').setStyle(ButtonStyle.Success).setDisabled(absence.status !== 'pending'),
    new ButtonBuilder().setCustomId(`absence:reject:${absence.id}`).setLabel('Refuser').setStyle(ButtonStyle.Danger).setDisabled(absence.status !== 'pending')
  );
}
function boardEmbed() {
  const now = Date.now();
  const current = state.absences.filter(a => a.status === 'approved' && a.startAt <= now && a.endAt > now).sort((a, b) => a.endAt - b.endAt);
  const embed = new EmbedBuilder().setColor(0x3498db).setTitle('Absences en cours').setTimestamp();
  if (!current.length) embed.setDescription('Aucune absence en cours.');
  else embed.setDescription(current.slice(0, 25).map(a => `• <@${a.userId}> — **${safeText(a.reason, 180)}**\n  Retour prévu : ${displayDate(a.endAt)}`).join('\n\n').slice(0, 4000));
  embed.setFooter({ text: `Mis à jour chaque minute • Fuseau : ${timezone}` });
  return embed;
}
async function fetchTextChannel(id) {
  const channel = await client.channels.fetch(id).catch(() => null);
  if (!channel?.isTextBased() || !channel.messages || channel.guildId !== guildId) throw new Error(`Le salon ${id} est introuvable, inaccessible ou n’appartient pas au serveur configuré.`);
  return channel;
}
async function ensureMessage(channelId, stateKey, payload) {
  const channel = await fetchTextChannel(channelId);
  const existingId = state[stateKey];
  if (existingId) {
    const existing = await channel.messages.fetch(existingId).catch(() => null);
    if (existing && existing.author.id === client.user.id) {
      await existing.edit(payload);
      return existing;
    }
  }
  const message = await channel.send(payload);
  state[stateKey] = message.id;
  saveState();
  return message;
}
let boardRefreshRunning = false;
async function refreshBoard() {
  if (boardRefreshRunning) return;
  boardRefreshRunning = true;
  try { await ensureMessage(config.absenceBoardChannelId, 'boardMessageId', { embeds: [boardEmbed()], allowedMentions: { parse: [] } }); }
  catch (error) { console.error('Mise à jour du panneau des absences impossible :', error.message); }
  finally { boardRefreshRunning = false; }
}
async function ensureRequestPanel() {
  try { await ensureMessage(config.absenceRequestChannelId, 'requestPanelMessageId', { embeds: [createPanelEmbed()], components: [createPanelRow()] }); }
  catch (error) { console.error('Panneau de demande d’absence impossible :', error.message); }
}
async function postReview(absence) {
  const channel = await fetchTextChannel(config.absenceReviewChannelId);
  let message = absence.reviewMessageId ? await channel.messages.fetch(absence.reviewMessageId).catch(() => null) : null;
  const payload = { embeds: [formatReviewEmbed(absence)], components: [reviewButtons(absence)], allowedMentions: { users: [absence.userId], parse: [] } };
  if (message) await message.edit(payload);
  else {
    message = await channel.send(payload);
    absence.reviewMessageId = message.id;
    saveState();
  }
}
async function restorePendingReviews() {
  for (const absence of state.absences.filter(a => a.status === 'pending')) {
    try { await postReview(absence); }
    catch (error) { console.error(`Restauration de la demande ${absence.id} impossible :`, error.message); }
  }
}
async function submitAbsence(interaction) {
  let startAt, endAt;
  try {
    startAt = toTimestamp(interaction.fields.getTextInputValue('start'));
    endAt = toTimestamp(interaction.fields.getTextInputValue('end'));
    if (endAt <= startAt) throw new Error('Le retour doit être après le départ.');
  } catch (error) { return interaction.reply({ content: error.message, ephemeral: true }); }
  const reason = interaction.fields.getTextInputValue('reason').trim();
  if (!reason) return interaction.reply({ content: 'Le motif ne peut pas être vide.', ephemeral: true });
  const absence = {
    id: randomUUID(), userId: interaction.user.id,
    reason, startAt, endAt,
    status: 'pending', createdAt: Date.now(), reviewMessageId: null
  };
  await interaction.deferReply({ ephemeral: true });
  state.absences.push(absence);
  try {
    saveState();
    await postReview(absence);
  } catch (error) {
    state.absences = state.absences.filter(a => a.id !== absence.id);
    try { saveState(); } catch (saveError) { console.error('Rollback de demande impossible :', saveError); }
    console.error('Création de la demande impossible :', error);
    return interaction.editReply('Impossible d’enregistrer/envoyer la demande. Préviens un administrateur.');
  }
  return interaction.editReply('Ta demande d’absence a été envoyée pour validation.');
}
async function decideAbsence(interaction, absence, decision, refusalReason = null) {
  if (absence.status !== 'pending') return interaction.reply({ content: 'Cette demande a déjà été traitée.', ephemeral: true });
  await interaction.deferReply({ ephemeral: true });
  const previous = { status: absence.status, decidedBy: absence.decidedBy, decidedAt: absence.decidedAt, decisionReason: absence.decisionReason };
  absence.status = decision;
  absence.decidedBy = interaction.user.id;
  absence.decidedAt = Date.now();
  if (refusalReason) absence.decisionReason = refusalReason.trim();
  try { saveState(); }
  catch (error) {
    Object.assign(absence, previous);
    console.error('Enregistrement de la décision impossible :', error);
    return interaction.editReply('La décision n’a pas pu être enregistrée. Réessaie.');
  }
  try { await postReview(absence); }
  catch (error) { console.error('La décision est enregistrée, mais le message de validation n’a pas pu être actualisé :', error); }
  if (decision === 'rejected') {
    const user = await client.users.fetch(absence.userId).catch(() => null);
    if (user) await user.send({ embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle('Demande d’absence refusée')
      .setDescription(`Ta demande du ${displayDate(absence.startAt)} au ${displayDate(absence.endAt)} a été refusée.\n**Motif :** ${safeText(refusalReason)}`)
      .setFooter({ text: `Décision par ${interaction.user.tag}` }).setTimestamp()], allowedMentions: { parse: [] } }).catch(() => null);
  }
  await interaction.editReply(decision === 'approved' ? 'Absence acceptée.' : 'Absence refusée. Un message privé a été envoyé si la personne accepte les MP.');
  if (decision === 'approved') await refreshBoard();
}

const wizardByMessage = new Map();
const wizardByNonce = new Map();
const DAY_MS = 86_400_000;
const tierNames = { warn1: 'Warn 1', warn2: 'Warn 2', suspension3Days: 'Mise à pied — 3 jours' };
const tierRoleId = type => config.sanctionRoles[type];
const tierDurationMs = type => sanctionDurations[type] * DAY_MS;
const activeFor = (userId, type, now = Date.now()) => state.sanctions.filter(s => s.userId === userId && s.type === type && s.status === 'active' && s.expiresAt > now);
function sanctionPanelEmbed() {
  return new EmbedBuilder().setColor(0xc0392b).setTitle('Panneau des sanctions')
    .setDescription('Clique sur le bouton pour choisir une personne et une sanction disponible. Ensuite, saisis le motif dans le modal, puis sélectionne jusqu’à cinq rôles à mentionner dans le journal.')
    .setFooter({ text: 'Les rôles de sanction expirent automatiquement, y compris après un redémarrage.' });
}
function sanctionPanelRow() {
  return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('sanction:open').setLabel('Créer une sanction').setStyle(ButtonStyle.Danger));
}
function sanctionWorkflowDescription(w) {
  return `**Personne :** ${w.targetUserId ? `<@${w.targetUserId}>` : 'à choisir'}\n**Sanction :** ${w.type ? tierNames[w.type] : 'à choisir'}\n**Rôles à mentionner :** ${w.mentionRoleIds.length ? w.mentionRoleIds.map(id => `<@&${id}>`).join(' ') : 'aucun'}`;
}
function eligibleTiers(member) {
  if (!member) return [];
  const now = Date.now();
  if (state.sanctions.some(s => s.userId === member.id && s.type === 'suspension3Days' && s.status === 'active')) return [];
  const hasWarn1 = member.roles.cache.has(tierRoleId('warn1')) && activeFor(member.id, 'warn1', now).length > 0;
  const hasWarn2 = member.roles.cache.has(tierRoleId('warn2')) && activeFor(member.id, 'warn2', now).length > 0;
  return ['warn1', ...(hasWarn1 ? ['warn2'] : []), ...(hasWarn1 && hasWarn2 ? ['suspension3Days'] : [])];
}
function wizardComponents(w) {
  const userSelect = new UserSelectMenuBuilder().setCustomId('sanction:target').setPlaceholder('1. Choisir la personne').setMinValues(1).setMaxValues(1);
  if (w.targetUserId) userSelect.setDefaultUsers(w.targetUserId);
  const tierOptions = w.allowedTiers?.length
    ? w.allowedTiers.map(type => new StringSelectMenuOptionBuilder().setLabel(tierNames[type]).setValue(type).setDefault(w.type === type))
    : [new StringSelectMenuOptionBuilder().setLabel('Aucune sanction disponible').setValue('none')];
  const tierSelect = new StringSelectMenuBuilder().setCustomId('sanction:tier').setPlaceholder('2. Choisir une sanction disponible').setMinValues(1).setMaxValues(1).addOptions(tierOptions);
  return [
    new ActionRowBuilder().addComponents(userSelect),
    new ActionRowBuilder().addComponents(tierSelect),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('sanction:continue').setLabel('Continuer vers le motif').setStyle(ButtonStyle.Primary).setDisabled(!w.targetUserId || !w.type))
  ];
}
function sanctionMentionComponents(w) {
  const roles = new RoleSelectMenuBuilder().setCustomId('sanction:mentions').setPlaceholder('Sélectionner jusqu’à 5 rôles à mentionner').setMinValues(0).setMaxValues(5);
  if (w.mentionRoleIds.length) roles.setDefaultRoles(w.mentionRoleIds);
  return [
    new ActionRowBuilder().addComponents(roles),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('sanction:apply').setLabel('Appliquer la sanction').setStyle(ButtonStyle.Danger))
  ];
}
function workflowFrom(interaction) {
  const w = wizardByMessage.get(interaction.message?.id);
  return w && w.ownerId === interaction.user.id && interaction.channelId === config.sanctionPanelChannelId ? w : null;
}
async function openSanctionWizard(interaction) {
  const w = { ownerId: interaction.user.id, guildId, targetUserId: null, type: null, allowedTiers: ['warn1'], mentionRoleIds: [] };
  const message = await interaction.reply({ content: sanctionWorkflowDescription(w), components: wizardComponents(w), ephemeral: true, fetchReply: true, allowedMentions: { parse: [] } });
  wizardByMessage.set(message.id, w);
  const timer = setTimeout(() => wizardByMessage.delete(message.id), 15 * 60_000); timer.unref?.();
}
async function refreshWizard(interaction, w) {
  const content = `${sanctionWorkflowDescription(w)}${w.reason ? `\n**Motif :** ${safeText(w.reason, 300)}` : ''}`;
  const payload = { content, components: w.reason ? sanctionMentionComponents(w) : wizardComponents(w), allowedMentions: { parse: [] } };
  if (interaction.deferred) await interaction.editReply(payload);
  else await interaction.update(payload);
}
function createSanctionReasonModal(nonce) {
  return new ModalBuilder().setCustomId(`sanction:reason:${nonce}`).setTitle('Motif de la sanction').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Motif détaillé').setStyle(TextInputStyle.Paragraph).setMaxLength(800).setRequired(true))
  );
}
async function handleSanctionInteraction(interaction) {
  if (interaction.isButton() && interaction.customId === 'sanction:open') {
    if (interaction.guildId !== guildId || interaction.channelId !== config.sanctionPanelChannelId) {
      await interaction.reply({ content: 'Utilise le panneau du salon de sanctions configuré.', ephemeral: true }); return true;
    }
    await openSanctionWizard(interaction); return true;
  }
  if (interaction.isUserSelectMenu() && interaction.customId === 'sanction:target') {
    const w = workflowFrom(interaction); if (!w) { await interaction.reply({ content: 'Ce formulaire a expiré ou ne t’appartient pas.', ephemeral: true }); return true; }
    await interaction.deferUpdate();
    const member = await interaction.guild.members.fetch({ user: interaction.values[0], force: true }).catch(() => null);
    if (!member) { await interaction.editReply({ content: 'Cette personne n’est plus membre du serveur.', components: wizardComponents(w) }); return true; }
    w.targetUserId = member.id; w.allowedTiers = eligibleTiers(member);
    if (!w.allowedTiers.includes(w.type)) w.type = null;
    await refreshWizard(interaction, w); return true;
  }
  if (interaction.isStringSelectMenu() && interaction.customId === 'sanction:tier') {
    const w = workflowFrom(interaction); if (!w) { await interaction.reply({ content: 'Ce formulaire a expiré ou ne t’appartient pas.', ephemeral: true }); return true; }
    await interaction.deferUpdate();
    const member = w.targetUserId ? await interaction.guild.members.fetch({ user: w.targetUserId, force: true }).catch(() => null) : null;
    w.allowedTiers = eligibleTiers(member);
    if (!w.allowedTiers.includes(interaction.values[0])) {
      w.type = null; await interaction.editReply({ content: `${sanctionWorkflowDescription(w)}\n⚠️ Cette sanction n’est pas disponible : la séquence de rôles requise n’est pas active.`, components: wizardComponents(w), allowedMentions: { parse: [] } }); return true;
    }
    w.type = interaction.values[0]; await refreshWizard(interaction, w); return true;
  }
  if (interaction.isRoleSelectMenu() && interaction.customId === 'sanction:mentions') {
    const w = workflowFrom(interaction); if (!w) { await interaction.reply({ content: 'Ce formulaire a expiré ou ne t’appartient pas.', ephemeral: true }); return true; }
    w.mentionRoleIds = interaction.values.slice(0, 5); await refreshWizard(interaction, w); return true;
  }
  if (interaction.isButton() && interaction.customId === 'sanction:apply') {
    const w = workflowFrom(interaction);
    if (!w || !w.reason) { await interaction.reply({ content: 'Ce formulaire a expiré ou ne t’appartient pas.', ephemeral: true }); return true; }
    wizardByMessage.delete(interaction.message.id);
    await interaction.deferReply({ ephemeral: true });
    await issueSanction(interaction, w, w.reason); return true;
  }
  if (interaction.isButton() && interaction.customId === 'sanction:continue') {
    const w = workflowFrom(interaction); if (!w) { await interaction.reply({ content: 'Ce formulaire a expiré ou ne t’appartient pas.', ephemeral: true }); return true; }
    if (!w.targetUserId || !w.type || !w.allowedTiers.includes(w.type)) {
      if (!w.allowedTiers.includes(w.type)) w.type = null;
      await interaction.update({ content: `${sanctionWorkflowDescription(w)}\n⚠️ Sélectionne une sanction autorisée pour la personne.`, components: wizardComponents(w), allowedMentions: { parse: [] } }); return true;
    }
    const nonce = randomUUID(); wizardByNonce.set(nonce, w); wizardByMessage.delete(interaction.message.id);
    const timer = setTimeout(() => wizardByNonce.delete(nonce), 15 * 60_000); timer.unref?.();
    await interaction.showModal(createSanctionReasonModal(nonce)); return true;
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith('sanction:reason:')) {
    const nonce = interaction.customId.slice('sanction:reason:'.length); const w = wizardByNonce.get(nonce);
    if (!w || w.ownerId !== interaction.user.id || interaction.guildId !== guildId || interaction.channelId !== config.sanctionPanelChannelId) {
      await interaction.reply({ content: 'Ce formulaire a expiré ou ne t’appartient pas.', ephemeral: true }); return true;
    }
    wizardByNonce.delete(nonce);
    const reason = interaction.fields.getTextInputValue('reason').trim();
    if (!reason) { await interaction.reply({ content: 'Le motif ne peut pas être vide.', ephemeral: true }); return true; }
    w.reason = reason;
    const message = await interaction.reply({ content: `${sanctionWorkflowDescription(w)}\n**Motif :** ${safeText(reason, 300)}\nChoisis jusqu’à cinq rôles à mentionner dans le journal, puis valide.`, components: sanctionMentionComponents(w), ephemeral: true, fetchReply: true, allowedMentions: { parse: [] } });
    wizardByMessage.set(message.id, w);
    const timer = setTimeout(() => wizardByMessage.delete(message.id), 15 * 60_000); timer.unref?.();
    return true;
  }
  return false;
}
const sanctionIssueInFlight = new Set();
async function issueSanction(interaction, w, reason) {
  const key = `${w.targetUserId}:${w.type}`;
  if (sanctionIssueInFlight.has(key)) return interaction.editReply('Une sanction de ce niveau est déjà en cours de traitement.');
  sanctionIssueInFlight.add(key);
  try { return await applySanction(interaction, w, reason); }
  finally { sanctionIssueInFlight.delete(key); }
}
async function applySanction(interaction, w, reason) {
  const guild = interaction.guild;
  const member = await guild.members.fetch({ user: w.targetUserId, force: true }).catch(() => null);
  const allowed = eligibleTiers(member);
  if (!member || !allowed.includes(w.type)) return interaction.editReply('Impossible : la personne ou les rôles requis ne sont plus présents.');
  if (state.sanctions.some(s => s.userId === member.id && s.type === w.type && s.status === 'active' && !s.roleApplied)) {
    return interaction.editReply('Une sanction de ce niveau est déjà en cours d’application pour cette personne.');
  }
  let expiresAt = Date.now() + tierDurationMs(w.type);
  let parentWarn1Id = null;
  if (w.type === 'warn2') {
    const priorWarn1 = activeFor(member.id, 'warn1').sort((a, b) => b.expiresAt - a.expiresAt)[0];
    if (!priorWarn1 || !member.roles.cache.has(tierRoleId('warn1'))) return interaction.editReply('Warn 2 exige un Warn 1 encore actif.');
    parentWarn1Id = priorWarn1.id; expiresAt = priorWarn1.expiresAt + tierDurationMs('warn2');
  }
  if (w.type === 'suspension3Days') {
    if (!activeFor(member.id, 'warn1').length || !activeFor(member.id, 'warn2').length) return interaction.editReply('La mise à pied exige Warn 1 et Warn 2 encore actifs.');
    expiresAt = Date.now() + tierDurationMs('suspension3Days');
  }
  const sanction = {
    id: randomUUID(), userId: member.id, moderatorId: interaction.user.id, type: w.type, reason,
    mentionRoleIds: w.mentionRoleIds.slice(0, 5), issuedAt: Date.now(), expiresAt, status: 'active',
    parentWarn1Id, roleApplied: false, createdLogPending: true, expiryLogPending: false
  };
  state.sanctions.push(sanction);
  try { saveState(); }
  catch (error) { state.sanctions = state.sanctions.filter(s => s.id !== sanction.id); console.error('Sauvegarde de sanction impossible:', error); return interaction.editReply('La sanction n’a pas pu être enregistrée. Rien n’a été appliqué.'); }
  try {
    await member.roles.add(tierRoleId(w.type), `Sanction ${tierNames[w.type]} par ${interaction.user.tag}: ${reason.slice(0, 300)}`);
  } catch (error) {
    console.error('Attribution immédiate du rôle impossible; la sanction persistée sera retentée automatiquement:', error);
    return interaction.editReply('La sanction est sauvegardée et le bot réessaiera automatiquement d’attribuer le rôle. Vérifie aussi sa permission Gérer les rôles et la hiérarchie des rôles.');
  }
  sanction.roleApplied = true;
  try { saveState(); } catch (error) { console.error('Le rôle a été appliqué mais son état n’a pas pu être réécrit; il sera vérifié au prochain cycle.', error); }
  await flushSanctionLogs();
  return interaction.editReply(`${tierNames[w.type]} appliqué à <@${member.id}> jusqu’au ${displayDate(expiresAt)}.`);
}
function sanctionLogEmbed(sanction, expired = false, cleared = false) {
  const title = expired ? `Sanction expirée — ${tierNames[sanction.type]}` : cleared ? 'Sanction retirée — fin de mise à pied' : `Sanction appliquée — ${tierNames[sanction.type]}`;
  const dateLabel = expired ? 'Expirée le' : cleared ? 'Retirée le' : 'Expire le';
  const eventTime = expired ? sanction.expiresAt : cleared ? (sanction.clearedAt || Date.now()) : sanction.issuedAt;
  return new EmbedBuilder().setColor(expired || cleared ? 0x95a5a6 : 0xe74c3c).setTitle(title)
    .setDescription(`**Personne :** <@${sanction.userId}>\n**Membre du staff :** <@${sanction.moderatorId}>\n**Motif :** ${safeText(sanction.reason, 800)}\n**${dateLabel} :** ${displayDate(expired || cleared ? eventTime : sanction.expiresAt)}${sanction.type === 'suspension3Days' && (expired || cleared) ? '\nLes rôles Warn 1 et Warn 2 ont aussi été retirés.' : ''}`)
    .setFooter({ text: `Sanction ${sanction.id}` }).setTimestamp(eventTime);
}
async function sendSanctionLog(sanction, mode) {
  const channel = await fetchTextChannel(config.sanctionLogChannelId);
  const content = mode === 'created' && sanction.mentionRoleIds?.length ? sanction.mentionRoleIds.map(id => `<@&${id}>`).join(' ') : undefined;
  await channel.send({ content, embeds: [sanctionLogEmbed(sanction, mode === 'expired', mode === 'cleared')], allowedMentions: { parse: [], roles: mode === 'created' ? sanction.mentionRoleIds || [] : [] } });
}
let sanctionLogFlushRunning = false;
async function flushSanctionLogs() {
  if (sanctionLogFlushRunning) return;
  sanctionLogFlushRunning = true;
  try {
  for (const sanction of state.sanctions) {
    if (sanction.createdLogPending && sanction.roleApplied) {
      try { await sendSanctionLog(sanction, 'created'); sanction.createdLogPending = false; saveState(); }
      catch (error) { console.error(`Journal de sanction ${sanction.id} indisponible (réessai automatique):`, error.message); }
    }
    if (sanction.expiryLogPending && sanction.expiryRolesSynced) {
      try { await sendSanctionLog(sanction, sanction.status === 'cleared' ? 'cleared' : 'expired'); sanction.expiryLogPending = false; saveState(); }
      catch (error) { console.error(`Journal d’expiration ${sanction.id} indisponible (réessai automatique):`, error.message); }
    }
  }
  } finally { sanctionLogFlushRunning = false; }
}
let sanctionReconcileRunning = false;
async function reconcileSanctions() {
  if (sanctionReconcileRunning) return;
  sanctionReconcileRunning = true;
  try {
  const now = Date.now(); let changed = false;
  const users = [...new Set(state.sanctions.filter(s => s.status === 'active').map(s => s.userId))];
  for (const userId of users) {
    const suspensions = state.sanctions.filter(s => s.userId === userId && s.type === 'suspension3Days' && s.status === 'active');
    if (suspensions.length) {
      const pending = suspensions.filter(s => s.expiresAt <= now);
      if (pending.length === suspensions.length) {
        for (const suspension of pending) {
          suspension.status = 'expired'; suspension.expiryLogPending = true; suspension.expiryRolesSynced = false;
          if (!suspension.roleApplied) suspension.createdLogPending = false;
        }
        for (const warning of state.sanctions.filter(s => s.userId === userId && ['warn1', 'warn2'].includes(s.type) && s.status === 'active')) {
          warning.status = 'cleared'; warning.expiryLogPending = true; warning.expiryRolesSynced = false; warning.clearedAt = now;
        }
        changed = true;
      }
    } else {
      for (const sanction of state.sanctions.filter(s => s.userId === userId && ['warn1', 'warn2'].includes(s.type) && s.status === 'active' && s.expiresAt <= now)) {
        sanction.status = 'expired'; sanction.expiryLogPending = true; sanction.expiryRolesSynced = false;
        if (!sanction.roleApplied) sanction.createdLogPending = false;
        changed = true;
      }
    }
  }
  if (changed) saveState();
  const affectedUsers = [...new Set(state.sanctions.filter(s => s.status === 'active' || (s.expiryLogPending && !s.expiryRolesSynced)).map(s => s.userId))];
  for (const userId of affectedUsers) {
    const member = await client.guilds.cache.get(guildId)?.members.fetch({ user: userId, force: true }).catch(() => null);
    if (!member) {
      for (const sanction of state.sanctions.filter(s => s.userId === userId && s.expiryLogPending && !s.expiryRolesSynced)) {
        sanction.expiryRolesSynced = true; changed = true;
      }
      continue;
    }
    const active = state.sanctions.filter(s => s.userId === userId && s.status === 'active');
    const hasSuspension = active.some(s => s.type === 'suspension3Days');
    const desired = new Set(); let roleSyncSucceeded = true;
    for (const type of ['warn1', 'warn2']) if (hasSuspension || active.some(s => s.type === type && s.expiresAt > Date.now())) desired.add(tierRoleId(type));
    if (hasSuspension) desired.add(tierRoleId('suspension3Days'));
    for (const type of ['warn1', 'warn2', 'suspension3Days']) {
      const roleId = tierRoleId(type); const present = member.roles.cache.has(roleId); const want = desired.has(roleId);
      try {
        if (want && !present) await member.roles.add(roleId, 'Réconciliation automatique des sanctions persistées');
        else if (!want && present) await member.roles.remove(roleId, 'Expiration/réconciliation automatique des sanctions');
      } catch (error) { roleSyncSucceeded = false; console.error(`Rôle ${roleId} non synchronisé pour ${userId}:`, error.message); }
    }
    if (roleSyncSucceeded) {
      for (const sanction of state.sanctions.filter(s => s.userId === userId && s.expiryLogPending && !s.expiryRolesSynced)) {
        sanction.expiryRolesSynced = true; changed = true;
      }
    }
    for (const sanction of active) {
      if (!sanction.roleApplied && member.roles.cache.has(tierRoleId(sanction.type))) { sanction.roleApplied = true; changed = true; }
      if (!sanction.roleApplied && sanction.expiresAt > Date.now()) {
        try { await member.roles.add(tierRoleId(sanction.type), 'Restauration d’une sanction persistée'); sanction.roleApplied = true; changed = true; }
        catch (error) { console.error(`Restauration du rôle de sanction impossible pour ${userId}:`, error.message); }
      }
    }
  }
  if (changed) saveState();
  await flushSanctionLogs();
  } finally { sanctionReconcileRunning = false; }
}
async function ensureSanctionPanel() {
  try { await ensureMessage(config.sanctionPanelChannelId, 'sanctionPanelMessageId', { embeds: [sanctionPanelEmbed()], components: [sanctionPanelRow()] }); }
  catch (error) { console.error('Panneau des sanctions impossible :', error.message); }
}
const panelChecksInFlight = new Set();
async function checkPersistentPanel(channelId, stateKey, payload, label) {
  if (panelChecksInFlight.has(stateKey)) return;
  panelChecksInFlight.add(stateKey);
  try {
    const channel = await fetchTextChannel(channelId);
    const message = state[stateKey] ? await channel.messages.fetch(state[stateKey]).catch(() => null) : null;
    if (!message || message.author.id !== client.user.id) {
      await ensureMessage(channelId, stateKey, payload);
      return;
    }
    const expectedButtonId = payload.components?.flatMap(row => row.components || []).map(component => component.customId || component.data?.custom_id)[0];
    const hasButton = !expectedButtonId || message.components.some(row => row.components.some(component => component.customId === expectedButtonId));
    if (!message.embeds.length || !hasButton) await message.edit(payload);
  } catch (error) { console.error(`Vérification du panneau ${label} impossible :`, error.message); }
  finally { panelChecksInFlight.delete(stateKey); }
}
async function checkSanctionPanel() {
  await checkPersistentPanel(config.sanctionPanelChannelId, 'sanctionPanelMessageId', { embeds: [sanctionPanelEmbed()], components: [sanctionPanelRow()] }, 'sanctions');
}
async function checkRequestPanel() {
  await checkPersistentPanel(config.absenceRequestChannelId, 'requestPanelMessageId', { embeds: [createPanelEmbed()], components: [createPanelRow()] }, 'demandes d’absence');
}
client.once('ready', async () => {
  try {
    await client.application.commands.set([], guildId);
    console.log('Commandes slash du serveur supprimées.');
  } catch (error) { console.error('Réinitialisation des commandes slash du serveur impossible :', error.message); }
  try {
    await client.application.commands.set([]);
    console.log('Commandes slash globales supprimées.');
  } catch (error) { console.error('Réinitialisation des commandes slash globales impossible :', error.message); }
  console.log(`Connecté en tant que ${client.user.tag} — serveur ${guildId}`);
  await ensureRequestPanel();
  await refreshBoard();
  await restorePendingReviews();
  await ensureSanctionPanel();
  await reconcileSanctions().catch(error => console.error('Réconciliation initiale des sanctions impossible :', error));
  setInterval(refreshBoard, 60_000);
  const panelTimer = setInterval(() => { checkRequestPanel(); checkSanctionPanel(); }, 60_000);
  panelTimer.unref?.();
  const sanctionTimer = setInterval(() => reconcileSanctions().catch(error => console.error('Réconciliation des sanctions impossible :', error)), 30_000);
  sanctionTimer.unref?.();
});
client.on('interactionCreate', async interaction => {
  try {
    if (await handleSanctionInteraction(interaction)) return;
    if (interaction.guildId !== guildId) return;
    if (interaction.isButton() && interaction.customId === 'absence:create') {
      if (interaction.channelId !== config.absenceRequestChannelId) return interaction.reply({ content: 'Utilise le panneau de demande configuré.', ephemeral: true });
      return interaction.showModal(createRequestModal());
    }
    if (interaction.isModalSubmit() && interaction.customId === 'absence:submit') {
      if (interaction.channelId !== config.absenceRequestChannelId) return interaction.reply({ content: 'Cette demande ne peut pas être envoyée depuis ce salon.', ephemeral: true });
      return await submitAbsence(interaction);
    }
    if (interaction.isButton() && (interaction.customId.startsWith('absence:approve:') || interaction.customId.startsWith('absence:reject:'))) {
      if (interaction.channelId !== config.absenceReviewChannelId) return interaction.reply({ content: 'Cette action est réservée au salon de validation configuré.', ephemeral: true });
      const [, action, id] = interaction.customId.split(':');
      const absence = state.absences.find(a => a.id === id);
      if (!absence) return interaction.reply({ content: 'Demande introuvable.', ephemeral: true });
      if (action === 'reject') {
        const modal = new ModalBuilder().setCustomId(`absence:reject-reason:${id}`).setTitle('Motif du refus').addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Raison communiquée à la personne').setStyle(TextInputStyle.Paragraph).setMaxLength(800).setRequired(true))
        );
        return interaction.showModal(modal);
      }
      return await decideAbsence(interaction, absence, 'approved');
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('absence:reject-reason:')) {
      if (interaction.channelId !== config.absenceReviewChannelId) return interaction.reply({ content: 'Cette action est réservée au salon de validation configuré.', ephemeral: true });
      const id = interaction.customId.slice('absence:reject-reason:'.length);
      const absence = state.absences.find(a => a.id === id);
      if (!absence) return interaction.reply({ content: 'Demande introuvable.', ephemeral: true });
      const refusalReason = interaction.fields.getTextInputValue('reason').trim();
      if (!refusalReason) return interaction.reply({ content: 'Le motif du refus ne peut pas être vide.', ephemeral: true });
      return await decideAbsence(interaction, absence, 'rejected', refusalReason);
    }
  } catch (error) {
    console.error('Erreur de traitement d’interaction :', error);
    if (interaction.isRepliable() && interaction.deferred && !interaction.replied) await interaction.editReply('Une erreur est survenue. Vérifie le salon des logs ou contacte un administrateur.').catch(() => {});
    else if (interaction.isRepliable() && !interaction.replied) await interaction.reply({ content: 'Une erreur est survenue. Réessaie ou contacte un administrateur.', ephemeral: true }).catch(() => {});
  }
});
client.on('error', error => console.error('Discord client error:', error));
process.on('unhandledRejection', error => console.error('Erreur asynchrone:', error));
client.login(config.token);
