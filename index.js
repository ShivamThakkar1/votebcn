const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const mongoose = require('mongoose');
const axios = require('axios');
const express = require('express');
require('dotenv').config();

// MongoDB Schema
const VoterSchema = new mongoose.Schema({
  nickname: String,
  votes: Number,
  lastVote: String,
});

const VoteDataSchema = new mongoose.Schema({
  serverId: { type: String, required: true, unique: true },
  lastUpdateHash: { type: String, default: '' },
  lastMessageId: { type: String, default: null },
  voters: [VoterSchema],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const VoteData = mongoose.model('VoteData', VoteDataSchema);

class MinecraftVoteBot {
  constructor() {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
    });

    this.serverKey = process.env.SERVER_KEY;
    this.channelId = process.env.CHANNEL_ID;
    this.mongoUrl = process.env.MONGO_URL;
    this.discordToken = process.env.DISCORD_TOKEN;
    this.period = process.env.PERIOD || this.getCurrentPeriod();
    this.format = process.env.FORMAT || 'json';
    this.port = process.env.PORT || 3000;

    this.setupEventHandlers();
    this.setupWebServer();
  }

  getCurrentPeriod() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    return `${year}${month}`;
  }

  setupWebServer() {
    const app = express();
    app.get('/', (req, res) => {
      res.json({ status: 'Bot is running', timestamp: new Date().toISOString() });
    });
    app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        bot: this.client.isReady() ? 'connected' : 'disconnected',
        mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
      });
    });
    app.listen(this.port, () => console.log(`Web server running on port ${this.port}`));
  }

  setupEventHandlers() {
    this.client.once('ready', async () => {
      console.log(`Bot is ready! Logged in as ${this.client.user.tag}`);
      await this.updateVoteMessage(); // Check once on start
      this.startVoteMonitoring();
    });
    this.client.on('error', console.error);
  }

  async connectToDatabase() {
    try {
      await mongoose.connect(this.mongoUrl, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
      });
      console.log('Connected to MongoDB');
    } catch (error) {
      console.error('MongoDB connection error:', error);
      process.exit(1);
    }
  }

  async fetchVoteCount() {
    try {
      const response = await axios.get(`https://minecraft-mp.com/api/?object=servers&element=voters&key=${this.serverKey}&month=${this.period}&format=${this.format}`);
      return response.data;
    } catch (error) {
      console.error('Error fetching vote count:', error.message);
      return null;
    }
  }

  async fetchVoteTimestamps() {
    try {
      const response = await axios.get(`https://minecraft-mp.com/api/?object=servers&element=votes&key=${this.serverKey}&format=${this.format}`);
      return response.data;
    } catch (error) {
      console.error('Error fetching vote timestamps:', error.message);
      return null;
    }
  }

  convertESTtoIST(estDateString) {
    if (!estDateString || estDateString === 'Unknown') return 'Unknown';
    let dateStr = estDateString.replace(' EST', '').trim().replace(/(\d+)(st|nd|rd|th)/, '$1');
    const estDate = new Date(dateStr);
    if (isNaN(estDate.getTime())) return 'Invalid Date';
    const istDate = new Date(estDate.getTime() + (10.5 * 60 * 60 * 1000));
    return istDate.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST';
  }

  getLatestTimestampForUser(timestamps, nickname) {
    const userVotes = timestamps.votes.filter(v => v.nickname === nickname);
    if (!userVotes.length) return null;
    userVotes.sort((a, b) => b.timestamp - a.timestamp);
    return userVotes[0];
  }

  generateDataHash(voters) {
    const dataString = JSON.stringify(voters);
    let hash = 0;
    for (let i = 0; i < dataString.length; i++) {
      const char = dataString.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString();
  }

  async createVoteEmbed(voters) {
    const embed = new EmbedBuilder()
      .setTitle('🗳️ Minecraft Vote Leaderboard')
      .setColor(0x00AE86)
      .setTimestamp()
      .setFooter({ text: 'Vote Tracker Bot' });

    let desc = '';

    if (voters.length === 0) {
      desc = 'No votes this month yet!';
    } else {
      voters.forEach((voter, i) => {
        desc += `**${i + 1}.** ${voter.nickname}\n`;
        desc += `**Votes:** ${voter.votes} — **Last Vote:** ${voter.lastVote}\n\n`;
      });
    }

    embed.setDescription(desc);
    return embed;
  }

  async updateVoteMessage() {
    try {
      const [voteData, timestampData] = await Promise.all([
        this.fetchVoteCount(),
        this.fetchVoteTimestamps()
      ]);

      if (!voteData || !voteData.voters || !timestampData) {
        console.log('API data missing.');
        return;
      }

      const voters = voteData.voters.map(v => {
        const lastVoteObj = this.getLatestTimestampForUser(timestampData, v.nickname);
        return {
          nickname: v.nickname,
          votes: parseInt(v.votes),
          lastVote: lastVoteObj ? this.convertESTtoIST(lastVoteObj.date) : 'Unknown'
        };
      });

      const newHash = this.generateDataHash(voters);
      let stored = await VoteData.findOne({ serverId: this.serverKey });

      const channel = await this.client.channels.fetch(this.channelId);
      if (!channel) {
        console.log('Channel not found');
        return;
      }

      let messageExists = true;
      if (!stored) {
        stored = new VoteData({ serverId: this.serverKey });
        messageExists = false;
      }

      if (stored.lastUpdateHash === newHash && messageExists) {
        try {
          await channel.messages.fetch(stored.lastMessageId);
          console.log('No changes detected');
          return;
        } catch {
          console.log('Previous message deleted. Reposting.');
        }
      }

      const embed = await this.createVoteEmbed(voters);
      let msg;

      if (stored.lastMessageId) {
        try {
          msg = await channel.messages.fetch(stored.lastMessageId);
          await msg.edit({ embeds: [embed] });
        } catch {
          msg = await channel.send({ embeds: [embed] });
          stored.lastMessageId = msg.id;
        }
      } else {
        msg = await channel.send({ embeds: [embed] });
        stored.lastMessageId = msg.id;
      }

      stored.voters = voters;
      stored.lastUpdateHash = newHash;
      stored.updatedAt = new Date();
      await stored.save();

      console.log('Vote message updated.');
    } catch (err) {
      console.error('Update error:', err.message);
    }
  }

  startVoteMonitoring() {
    console.log('Started vote monitoring...');
    setInterval(() => this.updateVoteMessage(), 10 * 60 * 1000);
  }

  async start() {
    await this.connectToDatabase();
    await this.client.login(this.discordToken);
  }
}

// Graceful shutdown
['SIGINT', 'SIGTERM'].forEach(signal => {
  process.on(signal, async () => {
    console.log(`Shutting down (${signal})...`);
    await mongoose.connection.close();
    process.exit(0);
  });
});

// Launch the bot
const bot = new MinecraftVoteBot();
bot.start();
