const express = require('express')
const listDatabases = require('../src/config/MongoConfig')
const { processSmsMatching } = require('../src/service/ConsumerAndMatch')
const cron = require('node-cron')
const mongoose = require('mongoose')
const logger = require('./config/logger')

const app = express()
app.use(express.json())

const processReceiptsInDatabase = async (dbname) => {
    try {
        await mongoose.connect(`${process.env.DATABASE_URL_MONGO}?authSource=admin`, {
            dbName: dbname
        })
        logger.info(`Conectado ao banco: ${dbname}. Processando recibos de sms\n\n`)
        await processSmsMatching()
        logger.info(`Recibos processados da base: ${dbname}\n`)
    } catch (error) {
        logger.error(`Erro ao realizar casamento ${error.message}`)
    } finally {
        await mongoose.disconnect(dbname)
    }
}

const orchestrateReceiptsProcessing = async () => {
    try {
        const database = await listDatabases()
        for (const dbname of database) {
            await processReceiptsInDatabase(dbname)
        }
    } catch (error) {
        logger.error(`Erro ao realizar casamento ${error.message}`)
    }
}

// cron.schedule('*/5 * * * *', async () => {
// }, {
//     scheduled: true,
//     timezone: 'America/Sao_Paulo'
// })
logger.info('🕒 Agendamento de tarefas configurados')
orchestrateReceiptsProcessing()
