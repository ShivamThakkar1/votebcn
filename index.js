const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const mongoose = require('mongoose');
const axios = require('axios');
const express = require('express');
require('dotenv').config();

// MongoDB Schema
const VoteDataSchema = new mongoose.Schema({
  serverId: { type: String, required: true, unique: true },
  lastUpdateHash: { type: String, default: '' },
  lastMessageId: { type: String, default: null },
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
      res.json({
        status: 'Bot is running',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
      });
    });

    app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        bot: this.client.isReady() ? 'connected' : 'disconnected',
        mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
      });
    });

    app.listen(this.port, () => {
      console.log(`Web server running on port ${this.port}`);
    });
  }

  setupEventHandlers() {
    this.client.once('ready', () => {
      console.log(`Bot is ready! Logged in as ${this.client.user.tag}`);
      this.startVoteMonitoring();
    });

    this.client.on('error', console.error);
  }

  async connectToDatabase() {
    try {
      await mongoose.connect(this.mongoUrl, {
        useNewUrlParser: true,
        useUnifiedTopology: true
      });
      console.log('Connected to MongoDB');
    } catch (error) {
      console.error('MongoDB connection error:', error);
      process.exit(1);
    }
  }

  async fetchVoteCount() {
    try {
      const response = await axios.get(
        `https://minecraft-mp.com/api/?object=servers&element=voters&key=${this.serverKey}&month=${this.period}&format=${this.format}`
      );
      return response.data;
    } catch (error) {
      console.error('Error fetching vote count:', error.message);
      return null;
    }
  }

  async fetchVoteTimestamps() {
    try {
      const response = await axios.get(
        `https://minecraft-mp.com/api/?object=servers&element=votes&key=${this.serverKey}&format=${this.format}`
      );
      return response.data;
    } catch (error) {
      console.error('Error fetching vote timestamps:', error.message);
      return null;
    }
  }

  convertESTtoIST(estDateString) {
    if (!estDateString || estDateString === 'Unknown') return 'Unknown';

    try {
      let dateStr = estDateString
        .replace(' EST', '')
        .trim()
        .replace(/(\d+)(st|nd|rd|th)/, '$1');

      const estDate = new Date(dateStr + ' GMT-0500');
      if (isNaN(estDate.getTime())) return 'Invalid Date';

      const istDate = new Date(estDate.getTime() + (10.5 * 60 * 60 * 1000));

      const day = istDate.getDate().toString().padStart(2, '0');
      const month = (istDate.getMonth() + 1).toString().padStart(2, '0');
      const year = istDate.getFullYear();

      let hours = istDate.getHours();
      const minutes = istDate.getMinutes().toString().padStart(2, '0');
      const seconds = istDate.getSeconds().toString().padStart(2, '0');

      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12;
      hours = hours === 0 ? 12 : hours;

      return `${day}/${month}/${year}, ${hours}:${minutes}:${seconds} ${ampm} IST`;
    } catch (err) {
      console.error('Date parse error:', err);
      return 'Invalid Date';
    }
  }

  getLatestTimestampForUser(timestamps, nickname) {
    const userVotes = timestamps.votes.filter(vote => vote.nickname === nickname);
    if (userVotes.length === 0) return null;

    userVotes.sort((a, b) => b.timestamp - a.timestamp);
    return userVotes[0];
  }

  async createVoteEmbed(voteData, timestampData) {
    if (!voteData || !voteData.voters || !timestampData) return null;

    const sortedVoters = voteData.voters.sort((a, b) => parseInt(b.votes) - parseInt(a.votes));

    const embed = new EmbedBuilder()
      .setTitle(voteData.name || 'Minecraft Server')
      .setColor(0x00AE86)
      .setTimestamp()
      .setFooter({ text: 'Vote Tracker Bot' });

    let description = '';

    if (sortedVoters.length === 0) {
      description = 'No votes this month yet!';
    } else {
      sortedVoters.forEach((voter, index) => {
        const latestVote = this.getLatestTimestampForUser(timestampData, voter.nickname);
        const lastVoteDate = latestVote ? this.convertESTtoIST(latestVote.date) : 'Unknown';

        description += `**${index + 1}.** ${voter.nickname}\n`;
        description += `**Votes:** ${voter.votes}\n`;
        description += `**Last Vote:** ${lastVoteDate}\n\n`;
      });
    }

    embed.setDescription(description);
    return embed;
  }

  generateDataHash(voteData, timestampData) {
    const dataString = JSON.stringify({
      voters: voteData?.voters || [],
      timestamps: timestampData?.votes || []
    });

    let hash = 0;
    for (let i = 0; i < dataString.length; i++) {
      const char = dataString.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString();
  }

  async updateVoteMessage() {
    try {
      const channel = await this.client.channels.fetch(this.channelId);
      if (!channel) {
        console.error('Channel not found');
        return;
      }

      const [voteData, timestampData] = await Promise.all([
        this.fetchVoteCount(),
        this.fetchVoteTimestamps()
      ]);

      if (!voteData || !timestampData) {
        console.log('Failed to fetch data from API');
        return;
      }

      const newHash = this.generateDataHash(voteData, timestampData);
      let storedData = await VoteData.findOne({ serverId: this.serverKey });
      if (!storedData) {
        storedData = new VoteData({ serverId: this.serverKey });
      }

      if (storedData.lastUpdateHash === newHash) {
        try {
          if (storedData.lastMessageId) {
            await channel.messages.fetch(storedData.lastMessageId);
            console.log('No changes detected, message still exists');
          } else {
            console.log('No changes detected, but no message found');
          }
        } catch {
          console.log('Message was deleted. Reposting...');
          const embed = await this.createVoteEmbed(voteData, timestampData);
          const newMessage = await channel.send({ embeds: [embed] });
          storedData.lastMessageId = newMessage.id;
          storedData.lastUpdateHash = newHash;
          storedData.updatedAt = new Date();
          await storedData.save();
        }
        return;
      }

      const embed = await this.createVoteEmbed(voteData, timestampData);
      if (!embed) {
        console.log('Failed to create embed');
        return;
      }

      let message;
      if (storedData.lastMessageId) {
        try {
          message = await channel.messages.fetch(storedData.lastMessageId);
          await message.edit({ embeds: [embed] });
          console.log('Updated existing message');
        } catch {
          message = await channel.send({ embeds: [embed] });
          storedData.lastMessageId = message.id;
          console.log('Previous message not found, sent new message');
        }
      } else {
        message = await channel.send({ embeds: [embed] });
        storedData.lastMessageId = message.id;
        console.log('Sent first vote message');
      }

      storedData.lastUpdateHash = newHash;
      storedData.updatedAt = new Date();
      await storedData.save();

      console.log('Vote message updated successfully');
    } catch (error) {
      console.error('Error updating vote message:', error);
    }
  }

  startVoteMonitoring() {
    console.log('Starting vote monitoring...');
    this.updateVoteMessage();
    setInterval(() => {
      this.updateVoteMessage();
    }, 10 * 60 * 1000); // Every 10 minutes
  }

  async start() {
    try {
      await this.connectToDatabase();
      await this.client.login(this.discordToken);
    } catch (error) {
      console.error('Error starting bot:', error);
      process.exit(1);
    }
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down bot...');
  await mongoose.connection.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down bot...');
  await mongoose.connection.close();
  process.exit(0);
});

// Start the bot
const bot = new MinecraftVoteBot();
bot.start();