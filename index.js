require('dotenv').config();
const {
  Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelType, PermissionFlagsBits
} = require('discord.js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID     = process.env.CLIENT_ID;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

// แจ้งช่องที่ต้องการ (guild -> channelId)
const notifyChannels = new Map(); // guildId -> channelId

// Slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('เปิดหน้าต่าง')
    .setDescription('🏯 เปิดแผงควบคุมสยาม ค่าย'),
  new SlashCommandBuilder()
    .setName('ตรวจเสียง')
    .setDescription('🎙️ เพิ่มบอทเข้าห้องเสียงเพื่อตรวจการอัดเสียง'),
  new SlashCommandBuilder()
    .setName('ออกเสียง')
    .setDescription('🔇 นำบอทออกจากห้องเสียง'),
  new SlashCommandBuilder()
    .setName('เซ็ตช่องแจ้ง')
    .setDescription('⚙️ ตั้งช่องสำหรับแจ้งเตือน')
    .addChannelOption(opt =>
      opt.setName('ช่อง').setDescription('ช่องที่ต้องการรับแจ้งเตือน').setRequired(true)
    ),
].map(c => c.toJSON());

async function registerCommands() {
  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    // ลบคำสั่งเก่าทั้งหมดก่อน
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
    // ลงทะเบียนคำสั่งใหม่
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('✅ Slash commands registered!');
  } catch(e) { console.error('❌ Register error:', e.message); }
}

// Recording trackers
const recordingUsers = new Map(); // userId -> true/false

client.on('voiceStateUpdate', async (oldState, newState) => {
  const guildId = newState.guild.id;
  const notifyChannelId = notifyChannels.get(guildId);
  if (!notifyChannelId) return;

  const channel = newState.guild.channels.cache.get(notifyChannelId);
  if (!channel) return;

  const member = newState.member;
  if (!member || member.user.bot) return;

  // ตรวจการอัดเสียง (selfVideo หรือ selfStream)
  const wasRecording = oldState.selfVideo || oldState.selfStream;
  const isRecording  = newState.selfVideo || newState.selfStream;

  if (!wasRecording && isRecording) {
    // เริ่มอัด
    const embed = new EmbedBuilder()
      .setColor(0xFF5722)
      .setTitle('🎙️ ตรวจพบการอัดเสียง/วิดีโอ!')
      .setDescription('ผู้ใช้ **' + member.displayName + '** กำลังอัดเสียง/วิดีโอในโทรคอล')
      .addFields(
        { name: '👤 ผู้ใช้', value: member.user.tag, inline: true },
        { name: '🔊 ห้อง', value: newState.channel ? newState.channel.name : 'ไม่ทราบ', inline: true },
      )
      .setTimestamp()
      .setFooter({ text: 'อาณาจักรสยาม ค่าย — Wintech Co.' });

    try { await channel.send({ embeds: [embed] }); } catch(e) {}
  } else if (wasRecording && !isRecording) {
    // หยุดอัด
    const embed = new EmbedBuilder()
      .setColor(0x4CAF50)
      .setTitle('✅ หยุดอัดเสียง/วิดีโอ')
      .setDescription('ผู้ใช้ **' + member.displayName + '** หยุดอัดเสียง/วิดีโอแล้ว')
      .addFields({ name: '👤 ผู้ใช้', value: member.user.tag, inline: true })
      .setTimestamp()
      .setFooter({ text: 'อาณาจักรสยาม ค่าย — Wintech Co.' });

    try { await channel.send({ embeds: [embed] }); } catch(e) {}
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'เปิดหน้าต่าง') {
    const embed = new EmbedBuilder()
      .setColor(0xD4A017)
      .setTitle('🏯 สยาม ค่าย — ราชสำนักดิจิทัล')
      .setDescription('```\n⚔️  อาณาจักรสยาม ค่าย\n   บริษัทวินเทค — WINTECH CO.\n```')
      .addFields(
        { name: '🌐 เว็บไซต์', value: '[เปิดราชสำนัก](' + (process.env.WEB_URL || 'https://siam-camp-production.up.railway.app') + ')', inline: true },
        { name: '📘 Facebook', value: '[กลุ่ม Facebook](https://www.facebook.com/groups/1253948663556474)', inline: true },
        { name: '💬 Discord', value: '[เซิร์ฟเวอร์](https://discord.gg/VxqNeEWBye)', inline: true },
      )
      .setTimestamp()
      .setFooter({ text: 'อาณาจักรสยาม ค่าย © ๒๕๖๙' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('🏯 เข้าราชสำนัก')
        .setStyle(ButtonStyle.Link)
        .setURL(process.env.WEB_URL || 'https://siam-camp-production.up.railway.app'),
      new ButtonBuilder()
        .setLabel('📘 Facebook')
        .setStyle(ButtonStyle.Link)
        .setURL('https://www.facebook.com/groups/1253948663556474'),
      new ButtonBuilder()
        .setLabel('💬 Discord')
        .setStyle(ButtonStyle.Link)
        .setURL('https://discord.gg/VxqNeEWBye'),
    );

    await interaction.reply({ embeds: [embed], components: [row] });
  }

  else if (commandName === 'ตรวจเสียง') {
    const member = interaction.member;
    const voiceChannel = member.voice.channel;
    if (!voiceChannel) {
      return interaction.reply({ content: '❌ กรุณาเข้าห้องเสียงก่อนใช้คำสั่งนี้', ephemeral: true });
    }

    if (!notifyChannels.has(interaction.guildId)) {
      return interaction.reply({ content: '❌ กรุณาตั้งช่องแจ้งเตือนก่อนด้วยคำสั่ง /เซ็ตช่องแจ้ง', ephemeral: true });
    }

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x4CAF50)
        .setTitle('🎙️ เริ่มตรวจสอบการอัดเสียง')
        .setDescription('บอทกำลังตรวจสอบห้อง **' + voiceChannel.name + '**\nหากมีการอัดเสียง/วิดีโอ จะแจ้งเตือนในช่องที่ตั้งไว้')
        .setTimestamp()],
    });
  }

  else if (commandName === 'ออกเสียง') {
    await interaction.reply({ content: '🔇 บอทไม่ได้อยู่ในห้องเสียง (ระบบตรวจเสียงทำงานอัตโนมัติ)', ephemeral: true });
  }

  else if (commandName === 'เซ็ตช่องแจ้ง') {
    const channel = interaction.options.getChannel('ช่อง');
    if (!channel || channel.type !== ChannelType.GuildText) {
      return interaction.reply({ content: '❌ กรุณาเลือกช่องข้อความ', ephemeral: true });
    }
    notifyChannels.set(interaction.guildId, channel.id);
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0xD4A017)
        .setTitle('✅ ตั้งช่องแจ้งเตือนสำเร็จ')
        .setDescription('การแจ้งเตือนจะส่งไปที่ <#' + channel.id + '>')
        .setTimestamp()],
    });
  }
});

client.once('clientReady', () => {
  console.log('✅ สยาม Bot พร้อมใช้งาน: ' + client.user.tag);
  registerCommands();
});

client.login(DISCORD_TOKEN);
