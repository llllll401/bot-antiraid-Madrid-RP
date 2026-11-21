const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder, GatewayIntentBits, SlashCommandBuilder,
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
const AUTO_ROLE_COMMAND_NAME = 'sanctions-auto-role';
const autoRoleCommand = new SlashCommandBuilder().setName(AUTO_ROLE_COMMAND_NAME)
  .setDescription('Activer ou désactiver la remise automatique des rôles de sanction')
  .addBooleanOption(option => option.setName('actif').setDescription('Activer la remise automatique').setRequired(true));

async function ensureAutoRoleCommand() {
  const guild = await client.guilds.fetch(guildId);
  const commands = await guild.commands.fetch();
  const existing = commands.find(command => command.name === AUTO_ROLE_COMMAND_NAME);
  if (existing) await guild.commands.edit(existing.id, autoRoleCommand.toJSON());
  else await guild.commands.create(autoRoleCommand.toJSON());
}

function emptyState() { return { boardMessageId: null, requestPanelMessageId: null, sanctionPanelMessageId: null, autoRestoreSanctionRoles: true, absences: [], sanctions: [] }; }
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
    a.endAt > a.startAt && ['pending', 'approved', 'rejected', 'cancelled'].includes(a.status));
  const rawSanctions = Array.isArray(parsed.sanctions) ? parsed.sanctions : [];
  const sanctions = rawSanctions.filter(s => s && typeof s === 'object' && typeof s.id === 'string' &&
    isSnowflake(s.userId) && isSnowflake(s.moderatorId) && typeof s.reason === 'string' &&
    ['warn1', 'warn2', 'suspension3Days'].includes(s.type) && ['active', 'expired', 'cleared', 'revoked', 'failed'].includes(s.status) &&
    Number.isFinite(s.issuedAt) && Number.isFinite(s.expiresAt) && s.expiresAt > s.issuedAt);
  if (absences.length !== parsed.absences.length || sanctions.length !== rawSanctions.length) console.warn('Certaines entrées invalides de absences.json ont été ignorées.');
  return {
    boardMessageId: isSnowflake(parsed.boardMessageId) ? parsed.boardMessageId : null,
    requestPanelMessageId: isSnowflake(parsed.requestPanelMessageId) ? parsed.requestPanelMessageId : null,
    sanctionPanelMessageId: isSnowflake(parsed.sanctionPanelMessageId) ? parsed.sanctionPanelMessageId : null,
    autoRestoreSanctionRoles: parsed.autoRestoreSanctionRoles !== false,
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
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('absence:create').setLabel('Créer une demande d’absence').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('absence:cancel-open').setLabel('Retirer une absence').setStyle(ButtonStyle.Secondary)
  );
}
function createRequestModal() {
  return new ModalBuilder().setCustomId('absence:submit').setTitle('Demande d’absence').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Motif de l’absence').setStyle(TextInputStyle.Paragraph).setMaxLength(800).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('start').setLabel('Départ (JJ/MM/AAAA HH:MM)').setPlaceholder('05/11/2026 14:30').setStyle(TextInputStyle.Short).setMaxLength(16).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('end').setLabel('Retour (JJ/MM/AAAA HH:MM)').setPlaceholder('08/11/2026 18:00').setStyle(TextInputStyle.Short).setMaxLength(16).setRequired(true))
  );
}
function formatReviewEmbed(absence) {
  const cancelled = absence.status === 'cancelled';
  const title = absence.status === 'pending' ? 'Demande d’absence à traiter' : cancelled ? 'Absence annulée par la personne' : `Demande ${absence.status === 'approved' ? 'acceptée' : 'refusée'}`;
  const color = absence.status === 'pending' ? 0xf1c40f : absence.status === 'approved' ? 0x2ecc71 : cancelled ? 0x95a5a6 : 0xe74c3c;
  return new EmbedBuilder().setColor(color).setTitle(title)
    .setDescription(`**Personne :** <@${absence.userId}>\n**Motif :** ${safeText(absence.reason)}\n**Départ :** ${displayDate(absence.startAt)}\n**Retour :** ${displayDate(absence.endAt)}${absence.decisionReason ? `\n**Motif du refus :** ${safeText(absence.decisionReason)}` : ''}${cancelled ? `\n**Annulée le :** ${displayDate(absence.cancelledAt || Date.now())}` : ''}`)
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
  try {
    const before = state.absences.length;
    state.absences = state.absences.filter(a => a.status !== 'rejected' && !(a.status === 'approved' && a.endAt <= Date.now()));
    if (state.absences.length !== before) saveState();
    await ensureMessage(config.absenceBoardChannelId, 'boardMessageId', { embeds: [boardEmbed()], allowedMentions: { parse: [] } });
  }
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
  for (const absence of state.absences.filter(a => a.status === 'pending' || (a.status === 'cancelled' && a.reviewSyncPending))) {
    try {
      await postReview(absence);
      if (absence.status === 'cancelled' && absence.reviewSyncPending) { delete absence.reviewSyncPending; saveState(); }
    } catch (error) { console.error(`Restauration de la demande ${absence.id} impossible :`, error.message); }
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
const cancellationWizardByMessage = new Map();
const absenceCancellationInFlight = new Set();
function cancellableAbsences(userId) {
  const now = Date.now();
  return state.absences.filter(a => a.userId === userId && ['pending', 'approved'].includes(a.status) && a.endAt > now)
    .sort((a, b) => a.startAt - b.startAt);
}
function cancellationComponents(w) {
  const options = (w.options || []).slice(0, 25).map(a => {
    const label = `${displayDate(a.startAt)} — ${safeText(a.reason, 65)}`.slice(0, 100);
    const status = a.status === 'pending' ? 'En attente de validation' : a.startAt <= Date.now() ? 'En cours' : 'À venir';
    return new StringSelectMenuOptionBuilder().setLabel(label).setDescription(status).setValue(a.id).setDefault(w.absenceId === a.id);
  });
  return [
    new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('absence:cancel-select').setPlaceholder('Choisir une absence à retirer').setMinValues(1).setMaxValues(1).addOptions(options)),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('absence:cancel-confirm').setLabel('Confirmer la suppression').setStyle(ButtonStyle.Danger).setDisabled(!w.absenceId))
  ];
}
async function openCancellationWizard(interaction) {
  const options = cancellableAbsences(interaction.user.id);
  if (!options.length) return interaction.reply({ content: 'Tu n’as aucune absence à venir ou en cours à retirer.', ephemeral: true });
  const w = { ownerId: interaction.user.id, absenceId: null, options };
  const message = await interaction.reply({ content: 'Voici tes absences à venir ou en cours (ainsi que tes demandes en attente). Choisis celle que tu veux retirer.', components: cancellationComponents(w), ephemeral: true, fetchReply: true, allowedMentions: { parse: [] } });
  cancellationWizardByMessage.set(message.id, w);
  const timer = setTimeout(() => cancellationWizardByMessage.delete(message.id), 15 * 60_000); timer.unref?.();
}
async function handleAbsenceCancellation(interaction) {
  if (interaction.isButton() && interaction.customId === 'absence:cancel-open') {
    if (interaction.guildId !== guildId || interaction.channelId !== config.absenceRequestChannelId) {
      await interaction.reply({ content: 'Utilise le bouton du salon de demandes configuré.', ephemeral: true }); return true;
    }
    await openCancellationWizard(interaction); return true;
  }
  if (interaction.isStringSelectMenu() && interaction.customId === 'absence:cancel-select') {
    const w = cancellationWizardByMessage.get(interaction.message?.id);
    if (!w || w.ownerId !== interaction.user.id || interaction.channelId !== config.absenceRequestChannelId) {
      await interaction.reply({ content: 'Ce formulaire a expiré ou ne t’appartient pas.', ephemeral: true }); return true;
    }
    const options = cancellableAbsences(interaction.user.id);
    const selected = options.find(a => a.id === interaction.values[0]);
    if (!selected) { await interaction.update({ content: 'Cette absence n’est plus disponible.', components: [] }); cancellationWizardByMessage.delete(interaction.message.id); return true; }
    w.options = options; w.absenceId = selected.id;
    await interaction.update({ content: `Confirme le retrait de **${displayDate(selected.startAt)} — ${safeText(selected.reason, 100)}** (${selected.status === 'pending' ? 'demande en attente' : selected.startAt <= Date.now() ? 'absence en cours' : 'absence à venir'}).`, components: cancellationComponents(w), allowedMentions: { parse: [] } });
    return true;
  }
  if (interaction.isButton() && interaction.customId === 'absence:cancel-confirm') {
    const w = cancellationWizardByMessage.get(interaction.message?.id);
    if (!w || w.ownerId !== interaction.user.id || interaction.channelId !== config.absenceRequestChannelId || !w.absenceId) {
      await interaction.reply({ content: 'Ce formulaire a expiré ou ne t’appartient pas.', ephemeral: true }); return true;
    }
    cancellationWizardByMessage.delete(interaction.message.id);
    await interaction.deferReply({ ephemeral: true });
    const absence = state.absences.find(a => a.id === w.absenceId && a.userId === interaction.user.id && ['pending', 'approved'].includes(a.status) && a.endAt > Date.now());
    if (!absence) return interaction.editReply('Cette absence n’est plus disponible à la suppression.');
    if (absenceCancellationInFlight.has(absence.id)) return interaction.editReply('Le retrait de cette absence est déjà en cours.');
    absenceCancellationInFlight.add(absence.id);
    const previous = { status: absence.status, cancelledBy: absence.cancelledBy, cancelledAt: absence.cancelledAt, reviewSyncPending: absence.reviewSyncPending };
    absence.status = 'cancelled'; absence.cancelledBy = interaction.user.id; absence.cancelledAt = Date.now(); absence.reviewSyncPending = true;
    try { saveState(); }
    catch (error) {
      Object.assign(absence, previous);
      console.error('Sauvegarde de l’annulation impossible :', error);
      absenceCancellationInFlight.delete(absence.id);
      return interaction.editReply('L’annulation n’a pas pu être enregistrée. Réessaie.');
    }
    try { await postReview(absence); delete absence.reviewSyncPending; saveState(); }
    catch (error) { console.error('Absence annulée mais synchronisation du message de validation en attente :', error); }
    absenceCancellationInFlight.delete(absence.id);
    await refreshBoard();
    return interaction.editReply('Ton absence a été retirée.');
  }
  return false;
}
async function decideAbsence(interaction, absence, decision, refusalReason = null) {
  if (absence.status !== 'pending') return interaction.reply({ content: 'Cette demande a déjà été traitée.', ephemeral: true });
  await interaction.deferReply({ ephemeral: true });
  if (absence.status !== 'pending') return interaction.editReply('Cette demande a déjà été traitée ou annulée.');
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
    .setDescription('Utilise **Créer une sanction** pour attribuer une sanction, ou **Enlever une sanction** pour retirer un niveau. Les sanctions suivantes descendent d’un rang en conservant leur motif. Les retraits sont consignés dans le journal.')
    .setFooter({ text: 'Les rôles de sanction expirent automatiquement, y compris après un redémarrage.' });
}
function sanctionPanelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('sanction:open').setLabel('Créer une sanction').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('sanction:open-suspension').setLabel('Mise à pied 3 jours').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('sanction:remove').setLabel('Enlever une sanction').setStyle(ButtonStyle.Secondary)
  );
}
function sanctionWorkflowDescription(w) {
  if (w.kind === 'revoke') return `**Personne :** ${w.targetUserId ? `<@${w.targetUserId}>` : 'à choisir'}\n**Sanction à retirer :** ${w.type ? tierNames[w.type] : 'à choisir'}`;
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
function revocableTiers(member) {
  if (!member) return [];
  return ['warn1', 'warn2', 'suspension3Days'].filter(type =>
    member.roles.cache.has(tierRoleId(type)) && state.sanctions.some(s => s.userId === member.id && s.type === type && s.status === 'active')
  );
}
function revokeWizardComponents(w) {
  const userSelect = new UserSelectMenuBuilder().setCustomId('sanction:target').setPlaceholder('1. Choisir la personne').setMinValues(1).setMaxValues(1);
  if (w.targetUserId) userSelect.setDefaultUsers(w.targetUserId);
  const options = w.allowedTiers?.length
    ? w.allowedTiers.map(type => new StringSelectMenuOptionBuilder().setLabel(tierNames[type]).setValue(type).setDefault(w.type === type))
    : [new StringSelectMenuOptionBuilder().setLabel('Aucune sanction active').setValue('none')];
  const tierSelect = new StringSelectMenuBuilder().setCustomId('sanction:tier').setPlaceholder('2. Choisir la sanction à retirer').setMinValues(1).setMaxValues(1).addOptions(options);
  return [
    new ActionRowBuilder().addComponents(userSelect),
    new ActionRowBuilder().addComponents(tierSelect),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('sanction:remove-confirm').setLabel('Confirmer le retrait').setStyle(ButtonStyle.Danger).setDisabled(!w.targetUserId || !w.type))
  ];
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
async function openSanctionWizard(interaction, quickSuspension = false) {
  const w = { kind: 'issue', ownerId: interaction.user.id, guildId, targetUserId: null, type: quickSuspension ? 'suspension3Days' : null, allowedTiers: quickSuspension ? ['suspension3Days'] : ['warn1'], quickSuspension, mentionRoleIds: [] };
  const message = await interaction.reply({ content: sanctionWorkflowDescription(w), components: wizardComponents(w), ephemeral: true, fetchReply: true, allowedMentions: { parse: [] } });
  wizardByMessage.set(message.id, w);
  const timer = setTimeout(() => wizardByMessage.delete(message.id), 15 * 60_000); timer.unref?.();
}
async function openRevokeWizard(interaction) {
  const w = { kind: 'revoke', ownerId: interaction.user.id, guildId, targetUserId: null, type: null, allowedTiers: [] };
  const message = await interaction.reply({ content: sanctionWorkflowDescription(w), components: revokeWizardComponents(w), ephemeral: true, fetchReply: true, allowedMentions: { parse: [] } });
  wizardByMessage.set(message.id, w);
  const timer = setTimeout(() => wizardByMessage.delete(message.id), 15 * 60_000); timer.unref?.();
}
async function refreshWizard(interaction, w) {
  const content = `${sanctionWorkflowDescription(w)}${w.notice ? `\n⚠️ ${w.notice}` : ''}${w.reason ? `\n**Motif :** ${safeText(w.reason, 300)}` : ''}`;
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
  if (interaction.isButton() && ['sanction:open', 'sanction:open-suspension'].includes(interaction.customId)) {
    if (interaction.guildId !== guildId || interaction.channelId !== config.sanctionPanelChannelId) {
      await interaction.reply({ content: 'Utilise le panneau du salon de sanctions configuré.', ephemeral: true }); return true;
    }
    await openSanctionWizard(interaction, interaction.customId === 'sanction:open-suspension'); return true;
  }
  if (interaction.isButton() && interaction.customId === 'sanction:remove') {
    if (interaction.guildId !== guildId || interaction.channelId !== config.sanctionPanelChannelId) {
      await interaction.reply({ content: 'Utilise le panneau du salon de sanctions configuré.', ephemeral: true }); return true;
    }
    await openRevokeWizard(interaction); return true;
  }
  if (interaction.isUserSelectMenu() && interaction.customId === 'sanction:target') {
    const w = workflowFrom(interaction); if (!w) { await interaction.reply({ content: 'Ce formulaire a expiré ou ne t’appartient pas.', ephemeral: true }); return true; }
    await interaction.deferUpdate();
    const member = await interaction.guild.members.fetch({ user: interaction.values[0], force: true }).catch(() => null);
    if (!member) { await interaction.editReply({ content: 'Cette personne n’est plus membre du serveur.', components: w.kind === 'revoke' ? revokeWizardComponents(w) : wizardComponents(w) }); return true; }
    w.targetUserId = member.id;
    if (w.kind === 'revoke') {
      w.allowedTiers = revocableTiers(member);
      if (!w.allowedTiers.includes(w.type)) w.type = null;
      const note = w.allowedTiers.length ? '' : '\nAucune sanction active à retirer pour cette personne.';
      await interaction.editReply({ content: `${sanctionWorkflowDescription(w)}${note}`, components: revokeWizardComponents(w), allowedMentions: { parse: [] } });
      return true;
    }
    w.allowedTiers = eligibleTiers(member);
    if (w.quickSuspension) w.allowedTiers = w.allowedTiers.filter(type => type === 'suspension3Days');
    if (!w.allowedTiers.includes(w.type)) w.type = null;
    w.notice = w.quickSuspension && !w.allowedTiers.length ? 'Cette personne doit avoir un Warn 1 et un Warn 2 actifs pour recevoir une mise à pied.' : null;
    await refreshWizard(interaction, w); return true;
  }
  if (interaction.isStringSelectMenu() && interaction.customId === 'sanction:tier') {
    const w = workflowFrom(interaction); if (!w) { await interaction.reply({ content: 'Ce formulaire a expiré ou ne t’appartient pas.', ephemeral: true }); return true; }
    await interaction.deferUpdate();
    const member = w.targetUserId ? await interaction.guild.members.fetch({ user: w.targetUserId, force: true }).catch(() => null) : null;
    w.allowedTiers = w.kind === 'revoke' ? revocableTiers(member) : eligibleTiers(member);
    if (w.quickSuspension) w.allowedTiers = w.allowedTiers.filter(type => type === 'suspension3Days');
    if (!w.allowedTiers.includes(interaction.values[0])) {
      w.type = null;
      const text = w.kind === 'revoke' ? '⚠️ Cette sanction n’est plus active.' : '⚠️ Cette sanction n’est pas disponible : la séquence de rôles requise n’est pas active.';
      await interaction.editReply({ content: `${sanctionWorkflowDescription(w)}\n${text}`, components: w.kind === 'revoke' ? revokeWizardComponents(w) : wizardComponents(w), allowedMentions: { parse: [] } }); return true;
    }
    w.type = interaction.values[0];
    if (w.kind === 'revoke') {
      const rank = { warn1: 1, warn2: 2, suspension3Days: 3 }[w.type];
      const cascade = rank === 1 ? 'Warn 1 sera retiré ; Warn 2 deviendra Warn 1 et la mise à pied deviendra Warn 2.' : rank === 2 ? 'Warn 2 sera retiré ; la mise à pied deviendra Warn 2.' : 'Seule la mise à pied sera retirée.';
      await interaction.editReply({ content: `${sanctionWorkflowDescription(w)}\n⚠️ ${cascade}`, components: revokeWizardComponents(w), allowedMentions: { parse: [] } });
    }
    else await refreshWizard(interaction, w);
    return true;
  }
  if (interaction.isRoleSelectMenu() && interaction.customId === 'sanction:mentions') {
    const w = workflowFrom(interaction); if (!w) { await interaction.reply({ content: 'Ce formulaire a expiré ou ne t’appartient pas.', ephemeral: true }); return true; }
    w.mentionRoleIds = interaction.values.slice(0, 5); await refreshWizard(interaction, w); return true;
  }
  if (interaction.isButton() && interaction.customId === 'sanction:remove-confirm') {
    const w = workflowFrom(interaction);
    if (!w || w.kind !== 'revoke' || !w.targetUserId || !w.type) { await interaction.reply({ content: 'Choisis une personne et une sanction active à retirer.', ephemeral: true }); return true; }
    wizardByMessage.delete(interaction.message.id);
    await interaction.deferReply({ ephemeral: true });
    const member = await interaction.guild.members.fetch({ user: w.targetUserId, force: true }).catch(() => null);
    if (!member || !revocableTiers(member).includes(w.type)) {
      await interaction.editReply('Cette sanction n’est plus active ou la personne n’est plus sur le serveur.'); return true;
    }
    await revokeSanction(interaction, member, w.type); return true;
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
const sanctionRanks = { warn1: 1, warn2: 2, suspension3Days: 3 };
const sanctionRemovalInFlight = new Set();
async function revokeSanction(interaction, member, type) {
  if (sanctionRemovalInFlight.has(member.id)) return interaction.editReply('Un retrait de sanction est déjà en cours pour cette personne.');
  sanctionRemovalInFlight.add(member.id);
  try {
    const rank = sanctionRanks[type];
    const impacted = state.sanctions.filter(s => s.userId === member.id && s.status === 'active' && sanctionRanks[s.type] >= rank);
    if (!impacted.length) return interaction.editReply('Aucune sanction active de ce niveau ou supérieure n’a été trouvée.');
    const now = Date.now();
    const snapshots = state.sanctions.filter(s => s.userId === member.id && s.status === 'active').map(s => ({ sanction: s, data: { ...s } }));
    const rankTypes = ['warn1', 'warn2', 'suspension3Days'];
    for (const sanction of impacted) {
      if (sanction.type === type) {
        sanction.status = 'revoked';
        sanction.revokedBy = interaction.user.id;
        sanction.revokedAt = now;
        sanction.revocationCascadeFrom = type;
        sanction.revocationLogPending = true;
        sanction.removalRolesSynced = false;
        if (!sanction.roleApplied) sanction.createdLogPending = false;
      } else {
        const previousType = sanction.type;
        sanction.type = rankTypes[sanctionRanks[previousType] - 2];
        sanction.typeBeforePromotion = previousType;
        sanction.promotedAt = now;
        sanction.promotedByRemoval = type;
        if (sanction.type === 'warn1') sanction.parentWarn1Id = null;
        else if (sanction.type === 'warn2') {
          const warn1 = state.sanctions.find(s => s.userId === member.id && s.status === 'active' && s.type === 'warn1' && s !== sanction);
          sanction.parentWarn1Id = warn1?.id || null;
        }
      }
    }
    try { saveState(); }
    catch (error) {
      for (const { sanction, data } of snapshots) { for (const key of Object.keys(sanction)) delete sanction[key]; Object.assign(sanction, data); }
      console.error('Enregistrement du retrait de sanction impossible :', error);
      return interaction.editReply('Le retrait n’a pas pu être enregistré. Aucune modification n’a été appliquée.');
    }
    await reconcileSanctions();
    const removedTypes = Object.keys(sanctionRanks).filter(t => sanctionRanks[t] >= rank);
    const stillPresent = removedTypes.filter(t => member.roles.cache.has(tierRoleId(t)) && !state.sanctions.some(s => s.userId === member.id && s.type === t && s.status === 'active'));
    if (stillPresent.length) return interaction.editReply('Le retrait est sauvegardé, mais un ou plusieurs rôles n’ont pas pu être enlevés. Le bot réessaiera automatiquement ; vérifie sa permission Gérer les rôles et la hiérarchie.');
    const cascadeText = rank === 1 ? 'Warn 1 retiré. Le Warn 2 est devenu Warn 1 et la mise à pied est devenue Warn 2 ; motifs et échéances conservés.' : rank === 2 ? 'Warn 2 retiré. La mise à pied est devenue Warn 2 ; motif et échéance conservés.' : 'Mise à pied retirée.';
    return interaction.editReply(cascadeText);
  } finally { sanctionRemovalInFlight.delete(member.id); }
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
function sanctionLogEmbed(sanction, mode = 'created') {
  const expired = mode === 'expired', cleared = mode === 'cleared', revoked = mode === 'revoked';
  const title = expired ? `Sanction expirée — ${tierNames[sanction.type]}` : cleared ? 'Sanction retirée — fin de mise à pied' : revoked ? `Sanction retirée — ${tierNames[sanction.type]}` : `Sanction appliquée — ${tierNames[sanction.type]}`;
  const eventTime = expired ? sanction.expiresAt : cleared ? (sanction.clearedAt || Date.now()) : revoked ? (sanction.revokedAt || Date.now()) : sanction.issuedAt;
  const dateLabel = expired ? 'Expirée le' : cleared || revoked ? 'Retirée le' : 'Expire le';
  const staffId = revoked ? sanction.revokedBy : sanction.moderatorId;
  const staffLabel = revoked ? 'Retrait effectué par' : 'Membre du staff';
  const cascade = revoked ? `\n**Action :** retrait de ${tierNames[sanction.revocationCascadeFrom] || 'la sanction'} ; les sanctions supérieures actives ont été rétrogradées d’un rang en conservant leur motif.` : '';
  return new EmbedBuilder().setColor(expired || cleared || revoked ? 0x95a5a6 : 0xe74c3c).setTitle(title)
    .setDescription(`**Personne :** <@${sanction.userId}>\n**${staffLabel} :** <@${staffId}>\n**Motif :** ${safeText(sanction.reason, 800)}\n**${dateLabel} :** ${displayDate(expired || cleared || revoked ? eventTime : sanction.expiresAt)}${sanction.type === 'suspension3Days' && (expired || cleared) ? '\nLes rôles Warn 1 et Warn 2 ont aussi été retirés.' : ''}${expired && sanction.promotedSanctionId ? '\nLe Warn 1 a expiré ; le Warn 2 suivant devient Warn 1 et son compte à rebours commence maintenant.' : ''}${cascade}`)
    .setFooter({ text: `Sanction ${sanction.id}` }).setTimestamp(eventTime);
}
async function sendSanctionLog(sanction, mode) {
  const channel = await fetchTextChannel(config.sanctionLogChannelId);
  const content = mode === 'created' && sanction.mentionRoleIds?.length ? sanction.mentionRoleIds.map(id => `<@&${id}>`).join(' ') : undefined;
  await channel.send({ content, embeds: [sanctionLogEmbed(sanction, mode)], allowedMentions: { parse: [], roles: mode === 'created' ? sanction.mentionRoleIds || [] : [] } });
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
    if (sanction.revocationLogPending && sanction.removalRolesSynced) {
      try { await sendSanctionLog(sanction, 'revoked'); sanction.revocationLogPending = false; saveState(); }
      catch (error) { console.error(`Journal de retrait ${sanction.id} indisponible (réessai automatique):`, error.message); }
    }
  }
  const before = state.sanctions.length;
  state.sanctions = state.sanctions.filter(s => !(['expired', 'cleared'].includes(s.status) && !s.expiryLogPending));
  if (state.sanctions.length !== before) saveState();
  } finally { sanctionLogFlushRunning = false; }
}
let sanctionReconcilePromise = null;
let sanctionReconcileRequested = false;
function reconcileSanctions() {
  if (sanctionReconcilePromise) {
    sanctionReconcileRequested = true;
    return sanctionReconcilePromise;
  }
  sanctionReconcilePromise = (async () => {
    do {
      sanctionReconcileRequested = false;
      await reconcileSanctionsPass();
    } while (sanctionReconcileRequested);
  })().finally(() => { sanctionReconcilePromise = null; });
  return sanctionReconcilePromise;
}
async function reconcileSanctionsPass() {
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
      const expiredWarn1s = state.sanctions.filter(s => s.userId === userId && s.type === 'warn1' && s.status === 'active' && s.expiresAt <= now);
      for (const warn1 of expiredWarn1s) {
        warn1.status = 'expired'; warn1.expiryLogPending = true; warn1.expiryRolesSynced = false;
        if (!warn1.roleApplied) warn1.createdLogPending = false;
        const nextWarn = state.sanctions.filter(s => s.userId === userId && s.type === 'warn2' && s.status === 'active' && s.expiresAt > now)
          .sort((a, b) => a.expiresAt - b.expiresAt)[0];
        if (nextWarn) {
          nextWarn.type = 'warn1';
          nextWarn.typeBeforePromotion = 'warn2';
          nextWarn.promotedAt = now;
          nextWarn.promotionReason = 'warn1_expired';
          nextWarn.parentWarn1Id = null;
          warn1.promotedSanctionId = nextWarn.id;
        }
        changed = true;
      }
      for (const sanction of state.sanctions.filter(s => s.userId === userId && ['warn1', 'warn2'].includes(s.type) && s.status === 'active' && s.expiresAt <= now)) {
        sanction.status = 'expired'; sanction.expiryLogPending = true; sanction.expiryRolesSynced = false;
        if (!sanction.roleApplied) sanction.createdLogPending = false;
        changed = true;
      }
    }
  }
  if (changed) saveState();
  const affectedUsers = [...new Set(state.sanctions.filter(s => s.status === 'active' || (s.expiryLogPending && !s.expiryRolesSynced) || (s.revocationLogPending && !s.removalRolesSynced)).map(s => s.userId))];
  for (const userId of affectedUsers) {
    const member = await client.guilds.cache.get(guildId)?.members.fetch({ user: userId, force: true }).catch(() => null);
    if (!member) {
      for (const sanction of state.sanctions.filter(s => s.userId === userId && s.expiryLogPending && !s.expiryRolesSynced)) {
        sanction.expiryRolesSynced = true; changed = true;
      }
      for (const sanction of state.sanctions.filter(s => s.userId === userId && s.revocationLogPending && !s.removalRolesSynced)) {
        sanction.removalRolesSynced = true; changed = true;
      }
      continue;
    }
    const active = state.sanctions.filter(s => s.userId === userId && s.status === 'active');
    for (const sanction of active) {
      const rolePresent = member.roles.cache.has(tierRoleId(sanction.type));
      if (!state.autoRestoreSanctionRoles && !rolePresent && !sanction.roleRestoreSuppressed) { sanction.roleRestoreSuppressed = true; changed = true; }
      else if (rolePresent && sanction.roleRestoreSuppressed) { delete sanction.roleRestoreSuppressed; changed = true; }
    }
    const hasSuspension = active.some(s => s.type === 'suspension3Days');
    const desired = new Set(); let roleSyncSucceeded = true;
    for (const type of ['warn1', 'warn2']) if (active.some(s => s.type === type && (hasSuspension || s.expiresAt > Date.now()) && !s.roleRestoreSuppressed)) desired.add(tierRoleId(type));
    if (hasSuspension && active.some(s => s.type === 'suspension3Days' && !s.roleRestoreSuppressed)) desired.add(tierRoleId('suspension3Days'));
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
      for (const sanction of state.sanctions.filter(s => s.userId === userId && s.revocationLogPending && !s.removalRolesSynced)) {
        sanction.removalRolesSynced = true; changed = true;
      }
    }
    for (const sanction of active) {
      if (!sanction.roleApplied && member.roles.cache.has(tierRoleId(sanction.type))) { sanction.roleApplied = true; changed = true; }
      if (state.autoRestoreSanctionRoles && !sanction.roleRestoreSuppressed && !sanction.roleApplied && sanction.expiresAt > Date.now()) {
        try { await member.roles.add(tierRoleId(sanction.type), 'Restauration d’une sanction persistée'); sanction.roleApplied = true; changed = true; }
        catch (error) { console.error(`Restauration du rôle de sanction impossible pour ${userId}:`, error.message); }
      }
    }
  }
  if (changed) saveState();
  await flushSanctionLogs();
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
    const expectedButtonIds = payload.components?.flatMap(row => row.components || []).map(component => component.customId || component.data?.custom_id) || [];
    const hasButtons = expectedButtonIds.every(id => message.components.some(row => row.components.some(component => component.customId === id)));
    if (!message.embeds.length || !hasButtons) await message.edit(payload);
  } catch (error) { console.error(`Vérification du panneau ${label} impossible :`, error.message); }
  finally { panelChecksInFlight.delete(stateKey); }
}
async function checkSanctionPanel() {
  await checkPersistentPanel(config.sanctionPanelChannelId, 'sanctionPanelMessageId', { embeds: [sanctionPanelEmbed()], components: [sanctionPanelRow()] }, 'sanctions');
}
async function checkRequestPanel() {
  await checkPersistentPanel(config.absenceRequestChannelId, 'requestPanelMessageId', { embeds: [createPanelEmbed()], components: [createPanelRow()] }, 'demandes d’absence');
}
async function handleAutoRoleCommand(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== AUTO_ROLE_COMMAND_NAME) return false;
  if (interaction.user.id !== '1239641924407660604') {
    await interaction.reply({ content: 'Tu n’es pas autorisé à modifier ce réglage.', ephemeral: true }); return true;
  }
  if (interaction.guildId !== guildId) {
    await interaction.reply({ content: 'Cette commande est disponible uniquement sur le serveur configuré.', ephemeral: true }); return true;
  }
  const previous = state.autoRestoreSanctionRoles;
  state.autoRestoreSanctionRoles = interaction.options.getBoolean('actif', true);
  try { saveState(); }
  catch (error) {
    state.autoRestoreSanctionRoles = previous;
    console.error('Enregistrement du réglage de remise automatique impossible :', error);
    await interaction.reply({ content: 'Le réglage n’a pas pu être enregistré.', ephemeral: true }); return true;
  }
  await interaction.deferReply({ ephemeral: true });
  await reconcileSanctions().catch(error => console.error('Réconciliation après changement du réglage impossible :', error));
  await interaction.editReply(state.autoRestoreSanctionRoles
    ? 'La remise automatique des rôles de sanction est activée. Les rôles retirés pendant qu’elle était désactivée ne seront pas remis automatiquement.'
    : 'La remise automatique des rôles de sanction est désactivée. Les rôles retirés pendant cette période ne seront pas remis automatiquement.');
  return true;
}
client.once('ready', async () => {
  try { await ensureAutoRoleCommand(); console.log(`Commande /${AUTO_ROLE_COMMAND_NAME} enregistrée.`); }
  catch (error) { console.error('Enregistrement de la commande de remise automatique impossible :', error.message); }
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
    if (await handleAutoRoleCommand(interaction)) return;
    if (await handleSanctionInteraction(interaction)) return;
    if (interaction.guildId !== guildId) return;
    if (await handleAbsenceCancellation(interaction)) return;
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
