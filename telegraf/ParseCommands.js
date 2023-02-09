const regex = /^\/([^@\s]+)@?(?:(\S+)|)\s?([\s\S]+)?$/i;

export function commandArgsMiddleware(ctx, next) {
    if (ctx.updateType === 'message') {
        const messageText = ctx.updateType === 'channel_post' ? ctx.channelPost.text : ctx.message.text
        if (messageText) {
            const parts = regex.exec(messageText)
            if (!parts)
                return next()
            const command = {
                text: messageText,
                command: parts[1],
                bot: parts[2],
                args: parts[3],
                get splitArgs() {
                    return !parts[3] ? [] : parts[3].split(/\s+/).filter(arg => arg.length)
                },
            }
            ctx.state.command = command
        }
    }
    return next()
}