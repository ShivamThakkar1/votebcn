const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const mongoose = require('mongoose');
const axios = require('axios');
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
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages
      ]
    });

    this.serverKey = process.env.SERVER_KEY;
    this.channelId = process.env.CHANNEL_ID;
    this.mongoUrl = process.env.MONGO_URL;
    this.discordToken = process.env.DISCORD_TOKEN;
    this.period = process.env.PERIOD || this.getCurrentPeriod();
    this.format = process.env.FORMAT || 'json';
    
    this.setupEventHandlers();
  }

  getCurrentPeriod() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    return `${year}${month}`;
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
    try {
      // Parse the EST date string
      const estDate = new Date(estDateString.replace(' EST', ' GMT-0500'));
      
      // Convert to IST (UTC+5:30)
      const istDate = new Date(estDate.getTime() + (10.5 * 60 * 60 * 1000)); // EST to IST is +10.5 hours
      
      // Format as readable string
      const options = {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Kolkata',
        timeZoneName: 'short'
      };
      
      return istDate.toLocaleDateString('en-US', options);
    } catch (error) {
      console.error('Error converting EST to IST:', error);
      return estDateString; // Return original if conversion fails
    }
  }

  getLatestTimestampForUser(timestamps, nickname) {
    const userVotes = timestamps.votes.filter(vote => vote.nickname === nickname);
    if (userVotes.length === 0) return null;
    
    // Sort by timestamp descending and get the latest
    userVotes.sort((a, b) => b.timestamp - a.timestamp);
    return userVotes[0];
  }

  async createVoteEmbed(voteData, timestampData) {
    if (!voteData || !voteData.voters || !timestampData) {
      return null;
    }

    // Sort voters by vote count (descending)
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
    
    // Simple hash function
    let hash = 0;
    for (let i = 0; i < dataString.length; i++) {
      const char = dataString.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
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
      
      // Check if data has changed
      let storedData = await VoteData.findOne({ serverId: this.serverKey });
      if (!storedData) {
        storedData = new VoteData({ serverId: this.serverKey });
      }

      if (storedData.lastUpdateHash === newHash) {
        console.log('No changes detected, skipping update');
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
        } catch (error) {
          console.log('Previous message not found, sending new message');
          message = await channel.send({ embeds: [embed] });
          storedData.lastMessageId = message.id;
        }
      } else {
        message = await channel.send({ embeds: [embed] });
        storedData.lastMessageId = message.id;
      }

      // Update stored data
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
    
    // Initial update
    this.updateVoteMessage();
    
    // Set interval for every 10 minutes (600,000 ms)
    setInterval(() => {
      this.updateVoteMessage();
    }, 10 * 60 * 1000);
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

// Handle process termination
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
