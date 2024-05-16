/* eslint-disable camelcase */
const SMS = require('../models/dispatchAndReceipts')
const MatchedSms = require('../models/finalreceipt')
const logger = require('../config/logger')

const transformBufferMessages = (retorno) => {
    if (retorno.pdu && retorno.pdu.short_message && retorno.pdu.short_message.message) {
        if (Buffer.isBuffer(retorno.pdu.short_message.message)) {
            return retorno.pdu.short_message.message.toString('utf8')
        }
        return retorno.pdu.short_message.message
    }
    logger.info(`short_message ou short_message.message não encontrado: ${JSON.stringify(retorno)}`)
    return null
}

const fetchSMSReceipts = async (batchSize, lastId = null) => {
    try {
        const baseQuery = { docType: 'disparo', ...(lastId ? { _id: { $gt: lastId } } : {}) }
        const disparos = await SMS.find(baseQuery).limit(batchSize).sort({ _id: 1 }).lean().exec()
        const countDisparo = await SMS.countDocuments({ docType: 'disparo' })
        logger.info(`Total de disparo: ${countDisparo}`)

        const baseQueryRetorno = { docType: 'retorno', ...(lastId ? { _id: { $gt: lastId } } : {}) }
        const retornos = await SMS.find(baseQueryRetorno).limit(batchSize).sort({ _id: 1 }).lean().exec()
        const countRecibos = await SMS.countDocuments({ docType: 'retorno' })
        logger.info(`Total de reccibos: ${countRecibos}`)

        const retornosTransformados = retornos.map(retorno => ({
            ...retorno,
            pdu: { ...retorno.pdu, short_message: { message: transformBufferMessages(retorno) } }
        }))

        return { disparos, retornosTransformados }
    } catch (error) {
        logger.error(`Erro ao buscar SMS: ${error.message}`)
        return { disparos: [], retornosTransformados: [] }
    }
}

const parseShortMessage = (shortMessageStr) => {
    try {
        if (typeof shortMessageStr !== 'string') {
            logger.info(`Entrada inválida ou não é uma string:', ${shortMessageStr}`)
            return {}
        }

        const regex = /id:(\d+)\s+sub:(\d*)\s+dlvrd:(\d+)\s+submit date:(\d+)\s+done date:(\d+)\s+stat:(\S+)\s+err:(\d+)\s+Text:(.*)/
        const match = shortMessageStr.match(regex)
        if (match) {
            return {
                messageId: match[1],
                sub: match[2],
                delivered: match[3],
                submitDate: match[4],
                doneDate: match[5],
                status: match[6],
                error: match[7],
                text: match[8].trim()
            }
        } else {
            logger.info(`Falha ao parsear a mensagem: ${shortMessageStr}`)
            return {}
        }
    } catch (error) {
        logger.error(`Erro ao fazer o parsing da mensagem curta: ${error.message}`)
        return {}
    }
}

const matchRecords = (disparos, retornos) => {
    try {
        const matched = []
        const groupedByMessageId = retornos.reduce((acc, retorno) => {
            if (retorno.pdu && retorno.pdu.short_message && retorno.pdu.short_message.message) {
                const parsedMessage = parseShortMessage(retorno.pdu.short_message.message)
                if (parsedMessage && parsedMessage.messageId) {
                    acc[parsedMessage.messageId] = acc[parsedMessage.messageId] || []
                    acc[parsedMessage.messageId].push({
                        ...retorno,
                        parsedMessage,
                        esm_class: retorno.pdu.esm_class
                    })
                }
            }
            return acc
        }, {})

        Object.keys(groupedByMessageId).forEach(messageId => {
            const entries = groupedByMessageId[messageId]
            const class4Entries = entries.filter(entry => entry.esm_class === 4)
            const class8Entries = entries.filter(entry => entry.esm_class === 8)

            if (class4Entries.length > 0 && class8Entries.length > 0) {
                const matchingDisparo = disparos.find(disparo => disparo.messageId === messageId)
                if (matchingDisparo) {
                    matched.push({ disparo: matchingDisparo, retornos: [class4Entries, class8Entries].flat() })
                }
            }
        })

        logger.info(`Encontrados ${matched.length} registros casados.`)
        return matched
    } catch (error) {
        logger.error(`Erro ao fazer o casamento de registros:${error.message}`)
        return []
    }
}

const matchRecordsDelayed = (disparos, retornos) => {
    try {
        const matched = []
        const groupedByMessageId = retornos.reduce((acc, retorno) => {
            if (retorno.pdu && retorno.pdu.short_message && retorno.pdu.short_message.message) {
                const parsedMessage = parseShortMessage(retorno.pdu.short_message.message)
                if (parsedMessage && parsedMessage.messageId) {
                    acc[parsedMessage.messageId] = acc[parsedMessage.messageId] || []
                    acc[parsedMessage.messageId].push({
                        ...retorno,
                        parsedMessage,
                        receiptDate: new Date(retorno.receiptDate)
                    })
                }
            }
            return acc
        }, {})

        Object.keys(groupedByMessageId).forEach(messageId => {
            const disparo = disparos.find(d => d.messageId === messageId)
            if (disparo) {
                const dispatchDate = new Date(disparo.dispatchDate)
                const validRetornos = groupedByMessageId[messageId].filter(retorno => {
                    const timeDiff = retorno.receiptDate.getTime() - dispatchDate.getTime()
                    return timeDiff > 259200000
                })

                if (validRetornos.length > 0) {
                    matched.push({ disparo, retornos: validRetornos })
                }
            }
        })

        logger.info(`Encontrados ${matched.length} registros casados com atraso de 3 dias ou mais.`)
        return matched
    } catch (error) {
        logger.error(`Erro ao fazer o casamento de registros atrasados:${error.message}`)
        return []
    }
}

const saveMatchedRecords = async (matchedRecords) => {
    try {
        const recordsToSave = matchedRecords.map(({ disparo, retornos }) => {
            const ap_retorno = retornos.filter(ret => ret.esm_class === 4 && ret.parsedMessage.status === 'ENROUTE')
            const op_retorno = retornos.filter(ret => ret.esm_class === 4 && ret.parsedMessage.status !== 'ENROUTE')
            const tm_retorno = retornos.filter(ret => ret.esm_class === 8)
            return {
                disparo,
                ap_retorno: ap_retorno.length > 0 ? formatRetorno(ap_retorno[0]) : undefined,
                op_retorno: op_retorno.length > 0 ? formatRetorno(op_retorno[0]) : undefined,
                tm_retorno: tm_retorno.length > 0 ? formatRetorno(tm_retorno[0]) : undefined
            }
        }).filter(record =>
            record.disparo &&
            record.ap_retorno &&
            record.op_retorno &&
            record.tm_retorno
        )
        if (recordsToSave.length > 0) {
            const result = await MatchedSms.insertMany(recordsToSave)
            logger.info(`${result.length} registros casados salvos.`)
        } else {
            logger.info('Nenhum registro completo para salvar')
        }
    } catch (error) {
        logger.error(`Erro ao salvar registros casados:${error.message}`)
    }
}

const formatRetorno = (retorno) => {
    return {
        command_status: retorno.pdu.command_status,
        sequence_number: retorno.pdu.sequence_number,
        command: retorno.pdu.command,
        source_addr: retorno.pdu.source_addr,
        destination_addr: retorno.pdu.destination_addr,
        esm_class: retorno.pdu.esm_class,
        protocol_id: retorno.pdu.protocol_id,
        priority_flag: retorno.pdu.priority_flag,
        schedule_delivery_time: retorno.pdu.schedule_delivery_time,
        validity_period: retorno.pdu.validity_period,
        registered_delivery: retorno.pdu.registered_delivery,
        replace_if_present_flag: retorno.pdu.replace_if_present_flag,
        data_coding: retorno.pdu.data_coding,
        sm_default_msg_id: retorno.pdu.sm_default_msg_id,
        short_message: {
            messageId: retorno.parsedMessage.messageId,
            sub: retorno.parsedMessage.sub,
            delivered: retorno.parsedMessage.delivered,
            submitDate: retorno.parsedMessage.submitDate,
            doneDate: retorno.parsedMessage.doneDate,
            status: retorno.parsedMessage.status,
            error: retorno.parsedMessage.error,
            text: retorno.parsedMessage.text
        },
        docType: retorno.docType,
        receiptDate: retorno.receiptDate
    }
}

const deleteMatchedRecords = async (matchedRecords, totalRecords) => {
    try {
        let deletedCount = 0
        let lastLoggedPercentage = 0
        for (const record of matchedRecords) {
            const idsToDelete = []
            if (record.disparo && record.disparo._id) {
                idsToDelete.push(record.disparo._id)
            }
            for (const retorno of record.retornos) {
                if (retorno && retorno._id) {
                    idsToDelete.push(retorno._id)
                }
            }
            for (const id of idsToDelete) {
                await SMS.deleteOne({ _id: id })
                deletedCount++
                let currentPercentage = Math.floor((deletedCount / totalRecords) * 100)

                currentPercentage = currentPercentage > 100 ? 100 : currentPercentage

                if (currentPercentage >= lastLoggedPercentage + 5 && currentPercentage <= 100) {
                    logger.info(`Sanitização da collection em andamento: ${currentPercentage}% ...`)
                    lastLoggedPercentage = currentPercentage
                }
            }
        }
    } catch (error) {
        logger.error(`Erro ao deletar registros casados: ${error.message}`)
    }
}

const processSmsMatching = async () => {
    try {
        const maxAttempt = 1
        let attempt = 0
        let batchSize = 375000
        let lastId = null

        while (attempt < maxAttempt) {
            logger.info(`Tentativa ${attempt + 1} com tamanho de lote ${batchSize}`)
            logger.info(`Processado lote com último ID: ${lastId}`)

            const { disparos, retornosTransformados } = await fetchSMSReceipts(batchSize, lastId)
            if (!disparos || disparos.length === 0 || !retornosTransformados || retornosTransformados.length === 0) {
                console.log('nenhum dado para processar')
            }
            if (disparos.length > 0 && retornosTransformados.length > 0) {
                const matchedRecords = matchRecords(disparos, retornosTransformados)

                if (matchedRecords.length > 0) {
                    await saveMatchedRecords(matchedRecords)
                    await deleteMatchedRecords(matchedRecords, matchedRecords.length)
                    logger.warn('Casamento e deleção completados.')
                } else {
                    logger.info('Nenhum registro para casar.')
                }
                lastId = disparos[disparos.length - 1]._id
            } else {
                logger.info('Nenhum retorno transformado para processar ou nenhum disparo retornado.')
                if (disparos.length > 0) {
                    lastId = disparos[disparos.length - 1]._id
                }
            }
            batchSize += 15000
            attempt++
        }
    } catch (error) {
        logger.error(`Erro no processo de casamento de SMS: ${error.message}`)
        console.log(error)
    }
}

module.exports = { processSmsMatching }
