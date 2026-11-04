const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder, GatewayIntentBits,
  ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (!config.token || /^(COLLER_|REMPLACER_|YOUR_)/i.test(config.token)) throw new Error('Renseignez le vrai token dans config.json');
if (!/^\d{17,20}$/.test(config.guildId || '')) throw new Error('Renseignez un guildId Discord valide dans config.json');
for (const field of ['absenceBoardChannelId', 'absenceRequestChannelId', 'absenceReviewChannelId']) {
  if (!/^\d{17,20}$/.test(config[field] || '')) throw new Error(`Renseignez ${field} dans config.json`);
}
const guildId = config.guildId;
const statePath = path.join(__dirname, 'absences.json');
const timezone = config.timezone || 'Europe/Paris';
const dateFormatter = new Intl.DateTimeFormat('fr-FR', {
  timeZone: timezone, day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

function loadState() {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return {
      boardMessageId: state.boardMessageId || null,
      requestPanelMessageId: state.requestPanelMessageId || null,
      absences: Array.isArray(state.absences) ? state.absences : []
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Impossible de lire ${statePath}: ${error.message}`);
    return { boardMessageId: null, requestPanelMessageId: null, absences: [] };
  }
}
const state = loadState();
function saveState() {
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, statePath);
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
  if (!channel?.isTextBased() || !channel.messages) throw new Error(`Le salon ${id} est introuvable ou n’est pas un salon textuel accessible.`);
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
async function refreshBoard() {
  try { await ensureMessage(config.absenceBoardChannelId, 'boardMessageId', { embeds: [boardEmbed()], allowedMentions: { parse: [] } }); }
  catch (error) { console.error('Mise à jour du panneau des absences impossible :', error.message); }
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
    if (startAt < Date.now() - 60000) throw new Error('La date de départ ne peut pas être dans le passé.');
  } catch (error) { return interaction.reply({ content: error.message, ephemeral: true }); }
  const reason = interaction.fields.getTextInputValue('reason').trim();
  if (!reason) return interaction.reply({ content: 'Le motif ne peut pas être vide.', ephemeral: true });
  const absence = {
    id: randomUUID(), userId: interaction.user.id,
    reason, startAt, endAt,
    status: 'pending', createdAt: Date.now(), reviewMessageId: null
  };
  state.absences.push(absence);
  try { saveState(); await postReview(absence); }
  catch (error) {
    state.absences = state.absences.filter(a => a.id !== absence.id);
    try { saveState(); } catch {}
    console.error('Création de la demande impossible :', error);
    return interaction.reply({ content: 'Impossible d’enregistrer/envoyer la demande. Préviens un administrateur.', ephemeral: true });
  }
  return interaction.reply({ content: 'Ta demande d’absence a été envoyée pour validation.', ephemeral: true });
}
async function decideAbsence(interaction, absence, decision, refusalReason = null) {
  if (absence.status !== 'pending') return interaction.reply({ content: 'Cette demande a déjà été traitée.', ephemeral: true });
  absence.status = decision;
  absence.decidedBy = interaction.user.id;
  absence.decidedAt = Date.now();
  if (refusalReason) absence.decisionReason = refusalReason.trim();
  try { saveState(); await postReview(absence); }
  catch (error) {
    absence.status = 'pending'; delete absence.decidedBy; delete absence.decidedAt; delete absence.decisionReason;
    console.error('Mise à jour de la décision impossible :', error);
    return interaction.reply({ content: 'La décision n’a pas pu être enregistrée. Réessaie.', ephemeral: true });
  }
  if (decision === 'rejected') {
    const user = await client.users.fetch(absence.userId).catch(() => null);
    if (user) await user.send({ embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle('Demande d’absence refusée')
      .setDescription(`Ta demande du ${displayDate(absence.startAt)} au ${displayDate(absence.endAt)} a été refusée.\n**Motif :** ${safeText(refusalReason)}`)
      .setFooter({ text: `Décision par ${interaction.user.tag}` }).setTimestamp()], allowedMentions: { parse: [] } }).catch(() => null);
  }
  await interaction.reply({ content: decision === 'approved' ? 'Absence acceptée.' : 'Absence refusée. Un message privé a été envoyé si la personne accepte les MP.', ephemeral: true });
  if (decision === 'approved') await refreshBoard();
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
  setInterval(refreshBoard, 60_000);
});
client.on('interactionCreate', async interaction => {
  try {
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
      return await decideAbsence(interaction, absence, 'rejected', interaction.fields.getTextInputValue('reason'));
    }
  } catch (error) {
    console.error('Erreur de traitement d’interaction :', error);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) await interaction.reply({ content: 'Une erreur est survenue. Réessaie ou contacte un administrateur.', ephemeral: true }).catch(() => {});
  }
});
client.on('error', error => console.error('Discord client error:', error));
process.on('unhandledRejection', error => console.error('Erreur asynchrone:', error));
client.login(config.token);
