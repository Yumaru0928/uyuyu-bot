const { Events } = require('discord.js');

module.exports = {
    name: Events.MessageCreate,
    async execute(message) {
        if (message.author.bot) return; // ボットのメッセージは無視
        
        if (message.content.includes('うゆゆ') || message.content.includes('uyuyu')){
            await message.react('1549375294614540409');
        }
    }
};