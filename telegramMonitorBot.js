import {Markup, Telegraf} from 'telegraf'
import {logger} from "./helpers/logger.js"
import {QuestWatcher} from "./questWatcher.js"
import _ from "lodash"
import {commandArgsMiddleware} from "./telegraf/ParseCommands.js"
import LocalSession from "telegraf-session-local"
import moment from "moment";
import {v4 as uuidv4} from 'uuid';

const bot = new Telegraf(process.env.BOT_TOKEN)

const localSession = new LocalSession({
    database: 'tg_sessions_db.json',
    property: 'session',
    storage: LocalSession.storageFileAsync,
    format: {
        serialize: (obj) => JSON.stringify(obj, null, 2),
        deserialize: (str) => JSON.parse(str),
    },
    state: {watcherConfigs: {}, crew3Servers: {}, claimRequests: {}}
})

localSession.DB.then(async DB => {
    logger.info('Current LocalSession DB:', DB.value())
    // logger.info(DB.get('sessions').getById('1:1').value())
    const value = DB.get('crew3Servers').value();
    if (_.some(value))
        for (const crewServerName in value) {
            let crewServerInfo = value[crewServerName]
            questsWatchers[crewServerInfo.chatId] = await startQuestWatcherByBindConfig(crewServerName, crewServerInfo.apiToken, getGroupConfig(crewServerInfo.chatId))
        }
})

bot.use(commandArgsMiddleware)
bot.use(localSession.middleware())
bot.launch()

const denyChars = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!']

function escapeMarkdown(str) {
    if (_.isUndefined(str) || _.isNumber(str) || _.isBoolean(str))
        return str
    for (const element of denyChars) str = str.replaceAll(element, `\\${element}`)
    return str
}

function isAdminOrCreatorOfChat(idOfChat, idOfUser, ctx) {
    return new Promise((resolve, reject) => {
        if (idOfChat === idOfUser) resolve(true)
        ctx.telegram.getChatMember(idOfChat, idOfUser).then((user) => {
            resolve(user.status === "administrator" || user.status === "creator")
        }).catch((error) => {
            reject(error)
        })
    })
}

function createEmptyConfig() {
    return {
        emoji: "📜",
        adminEmoji: "🔑",
        checkEmoji: true,
        likesToApprove: 10,
        sendClaimsOnlyToThisAdmins: [],
        admins: [],
        showWhoLikes: true,
        showApprovedMess: true,
        autoApprove: true,
        lang: "en",
        telegramQuestId: "no info"
    }
}

function configToPrint(config) {
    return `Configuration\\:\nTopic *emoji* to posting for vote here: ${escapeMarkdown(config.emoji)}` +
        `\n*Check emoji*: ${escapeMarkdown(config.checkEmoji)}` +
        `\n*Admins quests emoji*: ${escapeMarkdown(config.adminEmoji)}` +
        `\n*Likes to approve*: ${escapeMarkdown(config.likesToApprove)}` +
        `\n*Show who likes*: ${escapeMarkdown(config.showWhoLikes)}` +
        `\n*Auto approve by likes*: ${escapeMarkdown(config.autoApprove)}` +
        `\n*Show approved mess*: ${escapeMarkdown(config.showApprovedMess)}` +
        `\n*Admins*: ${escapeMarkdown(config.admins.join('\\, '))}` +
        `\n*Telegram bind questId*: ${escapeMarkdown(config.telegramQuestId)}` +
        `\n*bot lang*: ${escapeMarkdown(config.lang)}`
}

function trimSpecific(value, char) {
    return value.replace(new RegExp(`^[${char}]*(.*?)[${char}]*$`), '$1')
}

function getGroupConfig(chatId) {
    let configsByGroups = localSession.DB.get('watcherConfigs').value()
    if (!configsByGroups.hasOwnProperty(chatId))
        configsByGroups[chatId] = createEmptyConfig()
    return configsByGroups[chatId]
}

async function startQuestWatcherByBindConfig(communityCrew3Name, apiToken, config) {
    if (!config.lastCheckMoment)
        config.lastCheckMoment = moment().add(-7, "days")
    let qw = new QuestWatcher(apiToken, communityCrew3Name, config.lastCheckMoment, null);
    let intervalFunc = setInterval(async () => {
        let now = moment()
        let allClaims = await qw.FindNewClaimedQuests(config.lastCheckMoment)
        for (const claim of allClaims) {
            if (claim.type === "image")
                continue
            if (claim.name.includes(config.adminEmoji)) {
                await sendClaimToAdmins(claim)
                continue
            }
            if (!config.checkEmoji || claim.name.includes(config.emoji)) {
                await claimHandle(claim)
            }
        }
        config.lastCheckMoment = now
        await localSession.DB.get('watcherConfigs').write()
    }, 21 * 1000)
    return {
        watcher: qw, intervalFunc: intervalFunc
    }
}

let questsWatchers = {}
bot.command("bind", async (ctx, next) => {
    let chatId = ctx.message.chat.id
    try {
        let args = ctx.state.command.splitArgs
        if (args.length !== 3)
            return ctx.reply("You must set 3 arguments: communityName guid apiToken. Read help or write to support.")
        let communityCrew3Name = trimSpecific(args[0].trim(), "\"")
        const dbConfig = localSession.DB.get('crew3Servers');
        let crew3Servers = dbConfig.value()
        if (!crew3Servers.hasOwnProperty(communityCrew3Name))
            return ctx.reply("Incorrect crew3 community name: " + communityCrew3Name)
        let bindTgGroup = crew3Servers[communityCrew3Name]
        if (!(args[1] && args[1] === bindTgGroup.apiTokenRequestGuid))
            return ctx.reply("Incorrect guid for " + communityCrew3Name)
        bindTgGroup.apiToken = args[2]
        const groupConfig = getGroupConfig(bindTgGroup.chatId)
        questsWatchers[bindTgGroup.chatId] = await startQuestWatcherByBindConfig(communityCrew3Name, bindTgGroup.apiToken, groupConfig)
        await dbConfig.write()
        await ctx.reply("All is ok, questWatcher has been started for " + communityCrew3Name)
    } catch (error) {
        logger.error(JSON.stringify(error))
        ctx.reply("An error has occurred trying to parse arguments.")
    }
})
bot.command("getconfig", async (ctx, next) => {
    let chatId = ctx.message.chat.id
    try {
        let result = await isAdminOrCreatorOfChat(chatId, ctx.message.from.id, ctx)
        if (result) {
            let configsByGroups = localSession.DB.get('watcherConfigs').value()
            if (!configsByGroups.hasOwnProperty(chatId))
                return ctx.reply("Has no configuration for this group")
            let currentConfig = configsByGroups[chatId]
            ctx.replyWithMarkdownV2(configToPrint(currentConfig))
        } else {
            ctx.reply("You are not an admin of this group!")
        }
    } catch (error) {
        logger.error(JSON.stringify(error))
        ctx.reply("An error has occurred trying to get config.")
    }
})
bot.command("initcrew3here", async (ctx, next) => {
    let chatId = ctx.message.chat.id
    try {
        let result = await isAdminOrCreatorOfChat(chatId, ctx.message.from.id, ctx)
        if (result) {
            let args = ctx.state.command.splitArgs
            if (args.length !== 1)
                return ctx.reply("Set crew3-community name as first argument, it is a subdomain in url")
            let communityCrew3Name = trimSpecific(args[0].trim(), "\"")
            let mainChatByServer = localSession.DB.get('crew3Servers').value()
            if (mainChatByServer.hasOwnProperty(communityCrew3Name))
                return ctx.reply("The **** chat is already connected to the community " + communityCrew3Name)
            let apiTokenRequestGuid = uuidv4()
            mainChatByServer[communityCrew3Name] = {
                chatId: chatId,
                initTime: moment(),
                initiatorId: ctx.message.from.id,
                initiatorUserName: ctx.message.from.username,
                apiTokenRequestGuid: apiTokenRequestGuid
            }
            localSession.DB.get('crew3Servers').write()
            await ctx.reply(`Connecting to the community ${communityCrew3Name}.\nCheck PM for apiToken request.\nChat id: ${chatId}.`)
            //await ctx.replyWithMarkdownV2(`Connecting to the community *${escapeMarkdown(communityCrew3Name)}*\\\.\nCheck PM for apiToken request\\\.\nChat id\\\: *${escapeMarkdown(chatId)}*\\\.`)
            // send apiToken request to PM
            await bot.telegram.sendMessage(ctx.message.from.id, `Enter the api key to bind chatId(${chatId}) to the community ${communityCrew3Name}.\nUse current command:\n/bind ${communityCrew3Name} ${apiTokenRequestGuid} insertApiTokenHere`)
        } else {
            ctx.reply("You are not an admin or creator of this group!")
        }
    } catch (error) {
        logger.error(JSON.stringify(error))
        ctx.reply("An error has occurred trying to get config")
    }
})
bot.command("sendMeOtherClaimsToApproveAsAdmin", async (ctx, next) => {
    let chatId = ctx.message.chat.id
    try {
        let result = true // await isAdminOrCreatorOfChat(chatId, ctx.message.from.id, ctx)
        if (result) {
            let configsByGroups = localSession.DB.get('watcherConfigs').value()
            if (!configsByGroups.hasOwnProperty(chatId))
                return ctx.reply("Has no configuration for this group.")
            if (!questsWatchers.hasOwnProperty(chatId))
                return ctx.reply("QuestWatcher not started, please bind the community.")
            let currentConfig = configsByGroups[chatId]

            let adminTGUsername = `@${ctx.message.from.username}` // todo: check if exists
            if (!_.includes(currentConfig.admins, adminTGUsername))
                return ctx.reply("You are not allowed admin, change /configure")
            if (!_.some(currentConfig.sendClaimsOnlyToThisAdmins, {"chatId": ctx.message.from.id})) {
                currentConfig.sendClaimsOnlyToThisAdmins.push({
                    chatId: ctx.message.from.id,
                    username: ctx.message.from.username
                })
                localSession.DB.get('crew3Servers').write()
                await ctx.reply(`You are subscribed to emoji: ${currentConfig.adminEmoji}.`, {reply_to_message_id: ctx.message.message_id})
            } else {
                await ctx.reply(`You are already subscribed to ${currentConfig.adminEmoji}.`)
            }
        } else {
            ctx.reply("You are not an admin or creator of this group!")
        }
    } catch (error) {
        logger.error(JSON.stringify(error))
        ctx.reply("An error has occurred trying to get config.")
    }
})
bot.command("configure", async (ctx, next) => {
    let chatId = ctx.message.chat.id
    try {
        let result = await isAdminOrCreatorOfChat(chatId, ctx.message.from.id, ctx)
        if (result) {
            let currentConfig = getGroupConfig(chatId)

            let args = ctx.state.command.splitArgs
            for (const arg of args) {
                let trimmed = trimSpecific(arg.trim(), "\"")
                let array = trimmed.split(":")
                let command = array.length === 1 ? array : array[0]
                switch (command.toLowerCase()) {
                    case "emoji": {
                        currentConfig.emoji = array[1]
                        break;
                    }
                    case "adminemoji": {
                        currentConfig.adminEmoji = array[1]
                        break;
                    }
                    case "checkemoji": {
                        currentConfig.checkEmoji = array[1]
                        break;
                    }
                    case "admins": {
                        array.splice(0, 1)
                        currentConfig.admins = _.split(array, ",")
                        break;
                    }
                    case "likestoapprove": {
                        currentConfig.likesToApprove = parseInt(array[1])
                        break;
                    }
                    case "showwholikes": {
                        currentConfig.showWhoLikes = !!array[1]
                        break;
                    }
                    case "autoapprove": {
                        currentConfig.autoApprove = !!array[1]
                        break;
                    }
                    case "telegramquestid": {
                        currentConfig.telegramQuestId = array[1]
                        break;
                    }
                    case "showapprovedmess": {
                        currentConfig.showApprovedMess = !!array[1]
                        break;
                    }
                    case "lang": {
                        currentConfig.lang = array[1]
                        break;
                    }
                    default: {
                        return ctx.reply(`Invalid command: ${command}!`)
                    }
                }
            }
            await ctx.sessionDB.get('watcherConfigs').write()
            let markdown = configToPrint(currentConfig)
            ctx.replyWithMarkdownV2(markdown)
        } else {
            ctx.reply("You are not an admin of this group!")
        }
    } catch (error) {
        logger.error(JSON.stringify(error))
        ctx.reply("An error has occurred trying to get user rank.")
    }
})

bot.command("givexp", async (ctx, next) => {
    let chatId = ctx.message.chat.id
    try {
        let result = await isAdminOrCreatorOfChat(chatId, ctx.message.from.id, ctx)
        if (result) {
            let args = ctx.state.command.splitArgs
            if (args.length !== 2)
                return ctx.reply("Hint: /givexp 15 @userNick")
            let xp = parseInt(trimSpecific(args[0].trim(), "\""))
            if (!xp)
                return ctx.reply("Hint: /givexp 15 @userNick")
            let usernameForTips = trimSpecific(args[1].trim(), `"`)
            let configsByGroups = localSession.DB.get('watcherConfigs').value()
            if (!configsByGroups.hasOwnProperty(chatId))
                return ctx.reply("Has no configuration for this group.")
            if (!questsWatchers.hasOwnProperty(chatId))
                return ctx.reply("QuestWatcher not started, please bind the community.")
            let currentConfig = configsByGroups[chatId]

            let adminTGUsername = `@${ctx.message.from.username}` // todo: check if exists
            if (!_.includes(currentConfig.admins, adminTGUsername))
                return ctx.reply("You are not allowed admin, change /configure")
            if (!currentConfig.telegramQuestId)
                return ctx.reply("Not found telegramQuestId in configuration, fill it in /configure")
            const watcher = questsWatchers[chatId].watcher;
            let crew3UsersByTGUserName = await watcher.BindToTelegramUsernames(currentConfig.telegramQuestId)
            if (!crew3UsersByTGUserName.has(usernameForTips))
                return ctx.reply(`Not found "${usernameForTips}" in crew3, send to user the request to quest: ` + currentConfig.telegramQuestId)
            let crew3UserId = crew3UsersByTGUserName.get(usernameForTips).crew3UserId
            if (await watcher.GiveXP(crew3UserId, "XP from Telegram group", xp, `Give XP by TG-admin: ${(adminTGUsername)}`))
                await ctx.reply("given")
        } else {
            await ctx.reply("You are not an admin of this group!")
        }
    } catch (error) {
        logger.error(JSON.stringify(error))
        ctx.reply("An error has occurred trying to give XP, write to support or try later.")
    }
})
bot.command("removexp", async (ctx, next) => {
    let chatId = ctx.message.chat.id
    try {
        let result = await isAdminOrCreatorOfChat(chatId, ctx.message.from.id, ctx)
        if (result) {
            let args = ctx.state.command.splitArgs
            if (args.length !== 2)
                return ctx.reply("Hint: /removexp 15 @userNick")
            let xp = parseInt(trimSpecific(args[0].trim(), "\""))
            if (!xp)
                return ctx.reply("Hint: /removexp 15 @userNick")
            let usernameForTips = trimSpecific(args[1].trim(), `"`)
            let configsByGroups = localSession.DB.get('watcherConfigs').value()
            if (!configsByGroups.hasOwnProperty(chatId))
                return ctx.reply("Has no configuration for this group")

            let currentConfig = configsByGroups[chatId]
            let adminTGUsername = `@${ctx.message.from.username}` // todo: check if exists
            if (!_.includes(currentConfig.admins, adminTGUsername))
                return ctx.reply("You are not allowed admin, change /configure")
            if (!currentConfig.telegramQuestId)
                return ctx.reply("Not found telegramQuestId in configuration, fill it in /configure")
            const watcher = questsWatchers[chatId].watcher;
            let crew3UsersByTGUserName = await watcher.BindToTelegramUsernames(currentConfig.telegramQuestId)
            if (!crew3UsersByTGUserName.has(usernameForTips))
                return ctx.reply(`Not found "${usernameForTips}" in crew3, send to user the request to quest: ` + currentConfig.telegramQuestId)
            let crew3UserId = crew3UsersByTGUserName.get(usernameForTips).crew3UserId
            if (await watcher.RemoveXP(crew3UserId, "XP from Telegram group", xp, `Remove XP by TG-admin: ${(adminTGUsername)}`))
                ctx.reply("removed", {reply_to_message_id: ctx.message.message_id})
        } else {
            ctx.reply("You are not an admin of this group!")
        }
    } catch (error) {
        logger.error(JSON.stringify(error))
        ctx.reply("An error has occurred trying to remove XP, write to support or try later.")
    }
})
bot.command("transferxp", async (ctx, next) => {
    let chatId = ctx.message.chat.id
    try {
        let args = ctx.state.command.splitArgs
        if (args.length !== 2)
            return ctx.reply("Hint: /transferxp 15 @userNick")
        let xp = parseInt(trimSpecific(args[0].trim(), "\""))
        if (!xp)
            return ctx.reply("Hint: /transferxp 15 @userNick")
        let usernameRecipient = trimSpecific(args[1].trim(), "\"")
        let usernameDonor = `@${ctx.message.from.username}` // todo: check if exists
        let configsByGroups = localSession.DB.get('watcherConfigs').value()
        if (!configsByGroups.hasOwnProperty(chatId))
            return ctx.reply("Has no configuration for this group")

        let currentConfig = configsByGroups[chatId]
        if (!currentConfig.telegramQuestId)
            return ctx.reply("Not found telegramQuestId in configuration, admins must fill it in /configure")
        const watcher = questsWatchers[chatId].watcher;
        let crew3UsersByTGUserName = await watcher.BindToTelegramUsernames(currentConfig.telegramQuestId)
        if (!crew3UsersByTGUserName.has(usernameDonor))
            return ctx.reply(`Not found "${usernameDonor}" in crew3, send to user the request to quest: ` + currentConfig.telegramQuestId)
        let crew3UserId_Donor = crew3UsersByTGUserName.get(usernameDonor).crew3UserId
        if (!crew3UsersByTGUserName.has(usernameRecipient))
            return ctx.reply(`Not found ${usernameRecipient} in crew3, send to user the request to quest: ` + currentConfig.telegramQuestId)
        let crew3UserId_Recipient = crew3UsersByTGUserName.get(usernameRecipient).crew3UserId
        // todo: check user XP for <0
        if (await watcher.RemoveXP(crew3UserId_Donor, "XP to Telegram group", xp, `Send tips from you to ${usernameRecipient}`)) {
            await watcher.GiveXP(crew3UserId_Recipient, "XP from Telegram group", xp, `Receive tips from ${usernameDonor}`)
            ctx.reply(`Transferred ${xp} from ${usernameDonor} to ${usernameRecipient}`,
                {reply_to_message_id: ctx.message.message_id})
        } else {
            ctx.reply(`Can not transfer the ${xp} from ${usernameDonor}: maybe you don't have enough XP?`,
                {reply_to_message_id: ctx.message.message_id})
        }
    } catch (error) {
        logger.error(JSON.stringify(error))
        ctx.reply("An error has occurred trying to transfer XP. Try later or write to support.")
    }
})

function getClaimsDict(claimId) {
    let votesByClaim = localSession.DB.get('claimRequests').value()
    if (!votesByClaim.hasOwnProperty(claimId))
        return null
    return votesByClaim[claimId]
}

bot.on('callback_query', async (ctx) => {
    try {
        //'vote_like_3fd6227e-f20b-44b3-8298-b215a21a9bae': guid=36 chars
        let data = ctx.callbackQuery.data;
        let currentUserId = ctx.callbackQuery.from.id
        ctx.answerCbQuery()

        if (ctx.callbackQuery.from.is_bot)
            return

        if (data.startsWith("vote_")) {
            let claimId = data.substring(data.length - 36)
            let claimWithVotesInfo = getClaimsDict(claimId)
            if (claimWithVotesInfo) {
                let chatId = claimWithVotesInfo.communityCrew3ChatId
                let isLikeOp = data.startsWith("vote_like_")
                let array = isLikeOp ? claimWithVotesInfo.likes : claimWithVotesInfo.dislikes
                let index = _.findIndex(array, {userId: currentUserId})
                if (index === -1)
                    array.push({userId: currentUserId, userName: ctx.callbackQuery.from.username})
                else {
                    (isLikeOp ? claimWithVotesInfo.likes : claimWithVotesInfo.dislikes).splice(index, 1)
                }
                let currentConfig = getGroupConfig(chatId)

                let likes = claimWithVotesInfo.likes.length;
                let dislikes = claimWithVotesInfo.dislikes.length;
                let accepted = likes - dislikes >= currentConfig.likesToApprove
                if (accepted) {
                    if (currentConfig.autoApprove) {
                        ctx.editMessageReplyMarkup(createAcceptedButtons(accepted, likes, dislikes, claimId, false))
                        logger.info("Removing claim as accepted: " + claimId)
                        await questsWatchers[chatId].watcher.ReviewQuest("success", claimId, "Thanks from community. Accepted by https://t.me/crew3vote_bot") // todo: !!!
                        let votesByClaim = localSession.DB.get('claimRequests').value()
                        delete votesByClaim[claimId]
                        if (currentConfig.showApprovedMess) {
                            let adds = "\n"
                            if (currentConfig.showWhoLikes)
                                adds += `Likes:\n  @${claimWithVotesInfo.likes.map((x) => x.userName).join('\n  @')}\nDislikes: ${claimWithVotesInfo.dislikes.length > 0 ? ("\n  @" + claimWithVotesInfo.dislikes.map((x) => x.userName).join('\n  @')) : "0"}`
                            ctx.reply(`Quest approved: ${likes}👍\\${dislikes}👎.\nClaimID: ${claimId}\nCrew3 user: ${claimWithVotesInfo.userName}.${adds}`,
                                {reply_to_message_id: ctx.callbackQuery.message.message_id})
                        }
                    }
                } else
                    ctx.editMessageReplyMarkup(createVoteButtons("vote", likes, dislikes, claimId, false))
                await localSession.DB.get('claimRequests').write()
            } else {
                logger.warn("Not found quest, may be it removed: " + claimId)
            }
        }
        if (data.startsWith("admin_vote_")) {
            let claimId = data.substring(data.length - 36)
            let claimWithVotesInfo = getClaimsDict(claimId)
            if (claimWithVotesInfo) {
                let chatId = claimWithVotesInfo.communityCrew3ChatId
                let accepted = data.startsWith("admin_vote_like_")
                let array = claimWithVotesInfo.sentToAdmins
                if (!array || !_.isArray(array))
                    return
                let index = _.findIndex(array, {chatId: currentUserId})
                if (index === -1) { // no info, ignore it todo: show info message
                    return
                }
                for (const chat of array) {
                    try {
                        await bot.telegram.editMessageReplyMarkup(chat.chatId, chat.messageId, undefined, {
                            inline_keyboard: [[
                                Markup.button.callback(`${accepted ? "✅ Accepted" : "❎ Denied"} by @${ctx.callbackQuery.from.username}`, `${accepted ? "accepted" : "denied"}_${claimId}`)]
                            ]
                        })
                    } catch (e) {
                        logger.error(e)
                    }
                }
                logger.info(`Removing claim as ${accepted ? "✅ Accepted" : "❎ Denied"}: ${claimId}`)
                await questsWatchers[chatId].watcher.ReviewQuest(accepted ? "success" : "fail", claimId, "Operated by https://t.me/crew3vote_bot")
                let votesByClaim = localSession.DB.get('claimRequests').value()
                delete votesByClaim[claimId]
                delete claimWithVotesInfo.sentToAdmins
                await localSession.DB.get('claimRequests').write()
            } else {
                logger.warn("Not found quest, may be it removed: " + claimId)
            }
        }
    } catch (e) {
        logger.error(e)
    }
})

bot.command("help", async (ctx, next) => {
    let chatId = ctx.message.chat.id
    ctx.reply("transferxp - Transfer you XP to @username.\n" +
        "givexp - (admins from \"configure\"-commands only) Give XP to telegram user by @username\n" +
        "removexp - (admins only) Only admins can use this command.\n" +
        "configure - args: emoji:📜 checkEmoji:true admins:@user1,@user2 likesToApprove:2 showWhoLikes:false autoApprove:true showApprovedMess:true lang:en telegramQuestId:*** \n" +
        "getconfig - get config for current group\n" +
        "initcrew3here - bind to crew3. args: communityUrl(https://crew3.xyz/c/dashrus/)\n" +
        "Author - @berkutx. Twitter: @crew3vote_bot. Github: ")
})

process.once('SIGINT', () => {
    bot.stop('SIGINT')
    process.exit(0)
})
process.once('SIGTERM', () => bot.stop('SIGTERM'))

function createVoteButtons(prefix, like, dislike, id, addMarkup = true) {
    let result = {
        inline_keyboard: [[
            Markup.button.callback(like + " 👍 like", `${prefix}_like_${id}`),
            Markup.button.callback(dislike + " 👎 dislike", `${prefix}_dislike_${id}`)]]
    }
    return addMarkup ? {reply_markup: result} : result
}

function createAcceptedButtons(accepted, like, dislike, id, addMarkup = true) {
    let result = {
        inline_keyboard: [[
            Markup.button.callback(`(${like}\\${dislike}) ${accepted ? "✅ Accepted" : "❎ Denied"}`, `${accepted ? "accepted" : "denied"}_${id}`)
        ]]
    }
    return addMarkup ? {reply_markup: result} : result
}

function getCrew3Server(serverUrl) {
    let crew3Servers = localSession.DB.get('crew3Servers').value()
    if (crew3Servers.hasOwnProperty(serverUrl))
        return crew3Servers[serverUrl]
    else
        return null
}

function transferClaimToVoteClaim(communityCrew3Info, claimInfo) {
    return {
        likes: [],
        dislikes: [],
        name: claimInfo.name,
        userName: claimInfo.userName,
        questId: claimInfo.questId,
        linkToQuest: claimInfo.linkToQuest,
        communityCrew3ChatId: communityCrew3Info.chatId,
        crew3Server: claimInfo.server
    }
}

async function sendClaimToAdmins(claimInfo) {
    try {
        let communityCrew3Info = getCrew3Server(claimInfo.communityName)
        if (!communityCrew3Info)
            return logger.warn(`Not binding community(${claimInfo.communityName}) to telegram group.`)
        let claimVoteRecord = transferClaimToVoteClaim(communityCrew3Info, claimInfo)
        let votesByClaim = localSession.DB.get('claimRequests').value()
        let configsByGroups = localSession.DB.get('watcherConfigs').value()
        if (!configsByGroups.hasOwnProperty(communityCrew3Info.chatId))
            return logger.warn("QuestWatcher not started, please bind the community: " + claimInfo.communityName)
        let currentConfig = configsByGroups[communityCrew3Info.chatId]
        claimVoteRecord.sentToAdmins = []
        for (const admin of currentConfig.sendClaimsOnlyToThisAdmins) {
            try {
                let chatId = admin.chatId
                let updateInfo
                switch (claimInfo.type) {
                    case "image": {
                        updateInfo = await bot.telegram.sendMessage(chatId, {
                            text: `*${escapeMarkdown(claimInfo.name)}* \\- \`${claimInfo.reward.XP}\` XP\n${escapeMarkdown(claimInfo.url)}`,
                            parse_mode: "MarkdownV2"
                        }, createVoteButtons("admin_vote", 0, 0, claimInfo.id))
                        break;
                    }
                    case "text": {
                        updateInfo = await bot.telegram.sendMessage(chatId, {
                            text: `*${escapeMarkdown(claimInfo.name)}* \\- \`${claimInfo.reward.XP}\` XP\n${escapeMarkdown(claimInfo.mess)}`,
                            parse_mode: "MarkdownV2"
                        }, createVoteButtons("admin_vote", 0, 0, claimInfo.id))
                        break;
                    }
                    case "url": {
                        updateInfo = await bot.telegram.sendMessage(chatId, {
                            text: `*${escapeMarkdown(claimInfo.name)}* \\- \`${claimInfo.reward.XP}\` XP\n${escapeMarkdown(claimInfo.url)}`,
                            parse_mode: "MarkdownV2"
                        }, createVoteButtons("admin_vote", 0, 0, claimInfo.id))
                        break;
                    }
                    default: {
                        continue
                    }
                }
                claimVoteRecord.sentToAdmins.push({chatId: chatId, messageId: updateInfo.message_id})
            } catch (e) {
                logger.error(e)
            }
        }
        votesByClaim[claimInfo.id] = claimVoteRecord
        await localSession.DB.get('claimRequests').write()
    } catch (e) {
        logger.error(e)
    }
}

async function claimHandle(claimInfo) {
    try {
        let communityCrew3Info = getCrew3Server(claimInfo.communityName)
        if (!communityCrew3Info)
            return logger.warn(`Not binding community(${claimInfo.communityName}) to telegram group.`)
        let claimPrev = getClaimsDict(claimInfo.id)
        if (claimPrev)
            return logger.warn(`Claim(${claimInfo.id}) for community(${claimInfo.communityName}) already has been found`)
        let claimVoteRecord = transferClaimToVoteClaim(communityCrew3Info, claimInfo)
        let votesByClaim = localSession.DB.get('claimRequests').value()
        votesByClaim[claimInfo.id] = claimVoteRecord
        await localSession.DB.get('claimRequests').write()
        switch (claimInfo.type) {
            case "image": {
                await bot.telegram.sendMessage(communityCrew3Info.chatId, {
                    text: `*${escapeMarkdown(claimInfo.name)}* \\- \`${claimInfo.reward.XP}\` XP\n${escapeMarkdown(claimInfo.url)}`,
                    parse_mode: "MarkdownV2"
                }, createVoteButtons("vote", 0, 0, claimInfo.id))
                break;
            }
            case "text": {
                await bot.telegram.sendMessage(communityCrew3Info.chatId, {
                    text: `*${escapeMarkdown(claimInfo.name)}* \\- \`${claimInfo.reward.XP}\` XP\n${escapeMarkdown(claimInfo.mess)}`,
                    parse_mode: "MarkdownV2"
                }, createVoteButtons("vote", 0, 0, claimInfo.id))
                break;
            }
            case "url": {
                await bot.telegram.sendMessage(communityCrew3Info.chatId, {
                    text: `*${escapeMarkdown(claimInfo.name)}* \\- \`${claimInfo.reward.XP}\` XP\n${escapeMarkdown(claimInfo.url)}`,
                    parse_mode: "MarkdownV2"
                }, createVoteButtons("vote", 0, 0, claimInfo.id))
                break;
            }
            default: {

            }
        }
    } catch (e) {
        logger.error(e)
    }
}