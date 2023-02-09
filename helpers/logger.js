import {createLogger, format, transports } from 'winston'

const { combine, timestamp, label, prettyPrint } = format
//winston.emitErrs = true;

var logger = createLogger({
    format: format.combine(
        timestamp(),
        format.splat(),
        format.simple()
    ),
    transports: [
        new transports.File({
            timestamp: true,
            level: 'debug',
            filename: 'logs/log_' + (process.env.INSTANCE_ID ? process.env.INSTANCE_ID : 0) + '_.log',
            handleExceptions: true,
            humanReadableUnhandledException: true,
            json: true,
            maxsize: 15 * 1024 * 1024, //15MB
            maxFiles: 5,
            colorize: false
        }),
        new transports.Console({
            timestamp: true,
            level: 'debug',
            handleExceptions: true,
            humanReadableUnhandledException: true,
            json: true,
            colorize: true
        })
    ],
    exitOnError: false
});
if (process.env.NODE_ENV === "production") {
    logger.transports.console.level = 'info'
    logger.transports.file.level = 'info'
}

export {logger}