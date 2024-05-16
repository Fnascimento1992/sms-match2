const winston = require('winston')

const iconMap = {
    info: ' ',
    warn: '',
    error: '❌',
    debug: '🐛'

}

const customFormat = winston.format.printf(({ level, message, timestamp }) => {
    const icon = iconMap[level]
    return `${timestamp}-${icon} >> ${message}`
})

const logger = winston.createLogger({
    level: 'debug',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'DD-MM-YYYY HH:mm:ss' }),
        winston.format.simple(),
        customFormat
    ),

    transports: [
        new winston.transports.Console()
    ]
})

module.exports = logger
