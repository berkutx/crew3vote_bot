import got from 'got'
import fs from 'fs'
import moment from 'moment'
import {logger} from './helpers/logger.js'
import _ from "lodash"

const baseUrl = "https://crew3.xyz/c/"
const baseAPIUrl = "https://api.crew3.xyz/communities/"

class QuestWatcher {
    constructor(apiKey, communityName, lastCheckMoment, walletProcessor) {
        this.communityName = communityName // for logs
        this.baseCommunityUrl = baseUrl + communityName + "/"
        this.apiUrl = baseAPIUrl + communityName + "/"
        this.options = {
            headers: {
                'x-api-key': apiKey,
            }
        }
        this.walletProcessor = walletProcessor
    }

    generateClaimInfo(claim) {
        let info = {
            communityName: this.communityName,
            name: claim.name,
            id: claim.id,
            userName: claim.user.name,
            questId: claim.questId,
            reward: {},
            submission: {},
            type: "none"
        }
        if (claim.reward.length > 1)
            logger.warn(`quest.reward.lenght > 0: ${JSON.stringify(claim.reward)}`)
        switch (claim.reward[0].type) {
            case "xp": {
                info.reward.XP = claim.reward[0].value
                break;
            }
            default: {
                logger.warn(`found new submission type: ${claim.submission.type}`)
            }
        }

        switch (claim.submission.type) {
            case "url": {
                let url = claim.submission.value
                info.type = "url"
                info.url = "Url:\n" + url;
                break;
            }
            case "text": {
                let text = claim.submission.value
                info.type = "text"
                info.mess = "Answer:\n" + text;
                break;
            }
            case "image": {
                info.type = "image"
                info.url = claim.submission.value;
                break;
            }
            case "none": {
                let absoluteUrl = claim.submission.value
                break;
            }
            default: {
                logger.warn("Found new submission type: " + claim.submission.type)
            }
        }
        return info
    }

    async FindNewClaimedQuests(lastCheckMoment) {
        let result = []
        try {
            const {data} = await got.get(`${this.apiUrl}claimed-quests?status=pending&sortBy=updatedAt`, this.options).json()
            for (const claim of data) {
                let updatedAt = moment(claim.updatedAt)
                if (updatedAt.isAfter(lastCheckMoment)) {
                    logger.info(`[${this.communityName}] Found new claim(${claim.id}, type: ${claim.type}) to approve quest(${claim.questId}): ${claim.name}`)
                    let info = this.generateClaimInfo(claim)
                    result.push(info)
                }
            }
        } catch (e) {
            logger.error(`[${this.communityName}] [FindNewClaimedQuests] Error: ${e.toString()}`)
        }
        return result
    }

    async ReviewQuest(status, id, comment) {
        let params = _.clone(this.options)
        params["json"] = {status: status, claimedQuestIds: [id], comment: comment}
        const data = await got.post(`${this.apiUrl}claimed-quests/review`, params).json()
        logger.info(`[${this.communityName}] [review] claimId: ${id}. Answer from server: ${JSON.stringify(data)}`)
    }

    async GiveXP(userId, label, xp, description) {
        let params = _.clone(this.options)
        params["json"] = {label: label, xp: xp, description: description}
        const data = await got.post(`${this.apiUrl}users/${userId}/xp`, params).json()
        logger.info(`[${this.communityName}] [giveXP] Give ${xp} XP to ${userId}. Server answer:${JSON.stringify(data)}`)
        return data
    }

    async RemoveXP(userId, label, xp, description) {
        let params = _.clone(this.options)
        params["json"] = {label: label, xp: xp, description: description}
        const data = await got.delete(`${this.apiUrl}users/${userId}/xp`, params).json()
        logger.info(`[${this.communityName}] [removeXP] Remove ${xp} XP from ${userId}. serverAnswer: ${JSON.stringify(data)}`)
        return data
    }

    async GetAllUnclaimed(filterEmoji) {
        let claims = []
        try {
            const {data} = await got.get(`${this.apiUrl}claimed-quests?status=pending&sortBy=updatedAt`, this.options).json()
            for (const claim of data)
                if (claim.name.contains(filterEmoji))
                    claims.push(this.generateClaimInfo(claim))
        } catch (e) {
            logger.error(e)
        }
        return claims
    }

    async BindToTelegramUsernames(questId) {
        let params = _.clone(this.options)
        params["json"] = {questId: questId, success: true}
        const {data} = await got.get(`${this.apiUrl}claimed-quests`, this.options).json() // ?quest_id=${questId}&success=true
        let crew3UserIdByTGUserName = new Map()
        for (const item of data)
            crew3UserIdByTGUserName.set(item.submission.value.trim(), {
                crew3UserId: item.user.id,
                crew3Username: item.user.name
            })
        return crew3UserIdByTGUserName
    }
}

var now = moment().utc();
let config = {last_check_date: now.add(-1, 'days').utc()}
if (fs.existsSync("crew3_dash_config.json"))
    config = JSON.parse(fs.readFileSync("crew3_dash_config.json"))

export {QuestWatcher}