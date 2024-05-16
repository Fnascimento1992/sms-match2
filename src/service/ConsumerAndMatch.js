/* eslint-disable camelcase */
const SMS = require('../models/dispatchAndReceipts')
const MatchedSms = require('../models/finalreceipt')
const logger = require('../config/logger')

const transformBufferMessages = (retorno) => {
    if (retorno?.pdu?.short_message?.message) {
        const { message } = retorno.pdu.short_message;
        if (Buffer.isBuffer(message)) {
            return message.toString('utf8');
        }
        return message;
    }
    logger.info(`short_message ou short_message.message não encontrado: ${JSON.stringify(retorno)}`);
    return null;
};


const fetchSMSReceipts = async (batchSize, lastId = null) => {
    try {
        const baseQuery = { docType: 'disparo', ...(lastId ? { _id: { $gt: lastId } } : {}) };
        const disparos = await SMS.find(baseQuery).limit(batchSize).sort({ _id: 1 }).lean().exec();

        const baseQueryRetorno = { docType: 'retorno', ...(lastId ? { _id: { $gt: lastId } } : {}) };
        const retornos = await SMS.find(baseQueryRetorno).limit(batchSize).sort({ _id: 1 }).lean().exec();

        logger.info(`Total de disparo: ${await SMS.countDocuments({ docType: 'disparo' })}`);
        logger.info(`Total de recibos: ${await SMS.countDocuments({ docType: 'retorno' })}`);

        const retornosTransformados = retornos.map(retorno => ({
            ...retorno,
            pdu: { ...retorno.pdu, short_message: { message: transformBufferMessages(retorno) } }
        }));

        return { disparos, retornosTransformados };
    } catch (error) {
        logger.error(`Erro ao buscar SMS: ${error.message}`);
        return { disparos: [], retornosTransformados: [] };
    }
};


const parseShortMessage = (shortMessageStr) => {
    try {
        if (typeof shortMessageStr !== 'string') {
            logger.info(`Entrada inválida ou não é uma string:', ${shortMessageStr}`);
            return {};
        }

        const regex = /id:(\d+)\s+sub:(\d*)\s+dlvrd:(\d+)\s+submit date:(\d+)\s+done date:(\d+)\s+stat:(\S+)\s+err:(\d+)\s+Text:(.*)/;
        const match = shortMessageStr.match(regex);
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
            };
        } else {
            logger.info(`Falha ao parsear a mensagem: ${shortMessageStr}`);
            return {};
        }
    } catch (error) {
        logger.error(`Erro ao fazer o parsing da mensagem curta: ${error.message}`);
        return {};
    }
};


const matchRecords = (disparos, retornos) => {
    try {
        const groupedByMessageId = retornos.reduce((acc, retorno) => {
            const message = retorno?.pdu?.short_message?.message;
            if (message) {
                const parsedMessage = parseShortMessage(message);
                if (parsedMessage.messageId) {
                    acc[parsedMessage.messageId] = acc[parsedMessage.messageId] || [];
                    acc[parsedMessage.messageId].push({
                        ...retorno,
                        parsedMessage,
                        esm_class: retorno.pdu.esm_class
                    });
                }
            }
            return acc;
        }, {});

        const matched = Object.keys(groupedByMessageId).reduce((acc, messageId) => {
            const entries = groupedByMessageId[messageId];
            const class4Entries = entries.filter(entry => entry.esm_class === 4);
            const class8Entries = entries.filter(entry => entry.esm_class === 8);

            if (class4Entries.length > 0 && class8Entries.length > 0) {
                const matchingDisparo = disparos.find(disparo => disparo.messageId === messageId);
                if (matchingDisparo) {
                    acc.push({ disparo: matchingDisparo, retornos: [...class4Entries, ...class8Entries] });
                }
            }
            return acc;
        }, []);

        logger.info(`Encontrados ${matched.length} registros casados.`);
        return matched;
    } catch (error) {
        logger.error(`Erro ao fazer o casamento de registros: ${error.message}`);
        return [];
    }
};

const isDateThreeDaysOlder = (date) => {
    const currentDate = new Date();
    const givenDate = new Date(date);
    const diffInTime = currentDate.getTime() - givenDate.getTime();
    const diffInDays = diffInTime / (1000 * 3600 * 24);
    return diffInDays > 3;
};

const matchRecordsDelayed = (disparos, retornos) => {
    try {
        const matched = [];
        const groupedByMessageId = retornos.reduce((acc, retorno) => {
            if (retorno.pdu && retorno.pdu.short_message && retorno.pdu.short_message.message) {
                const parsedMessage = parseShortMessage(retorno.pdu.short_message.message);
                if (parsedMessage && parsedMessage.messageId) {
                    acc[parsedMessage.messageId] = acc[parsedMessage.messageId] || [];
                    acc[parsedMessage.messageId].push({
                        ...retorno,
                        parsedMessage,
                        receiptDate: new Date(retorno.receiptDate)
                    });
                }
            }
            return acc;
        }, {});

        Object.keys(groupedByMessageId).forEach(messageId => {
            const disparo = disparos.find(d => d.messageId === messageId);
            if (disparo && isDateThreeDaysOlder(disparo.dispatchDate)) {
                const validRetornos = groupedByMessageId[messageId].filter(retorno =>
                    isDateThreeDaysOlder(retorno.receiptDate) && retorno.esm_class !== 8
                );

                if (validRetornos.length > 0) {
                    matched.push({ disparo, retornos: validRetornos });
                }
            }
        });

        logger.info(`Encontrados ${matched.length} registros casados com atraso de 3 dias ou mais.`);
        return matched;
    } catch (error) {
        logger.error(`Erro ao fazer o casamento de registros atrasados: ${error.message}`);
        return [];
    }
};


const saveMatchedRecords = async (matchedRecords) => {
    try {
        const recordsToSave = matchedRecords.map(({ disparo, retornos }) => {
            const ap_retorno = retornos.filter(ret => ret.pdu.esm_class === 4 && ret.parsedMessage.status === 'ENROUTE');
            const op_retorno = retornos.filter(ret => ret.pdu.esm_class === 4 && ret.parsedMessage.status !== 'ENROUTE');
            const tm_retorno = retornos.filter(ret => ret.pdu.esm_class === 8);

            return {
                disparo,
                ap_retorno: ap_retorno.length > 0 ? formatRetorno(ap_retorno[0]) : undefined,
                op_retorno: op_retorno.length > 0 ? formatRetorno(op_retorno[0]) : undefined,
                tm_retorno: tm_retorno.length > 0 ? formatRetorno(tm_retorno[0]) : undefined
            };
        }).filter(record =>
            record.disparo &&
            record.ap_retorno &&
            record.op_retorno &&
            record.tm_retorno
        );
        if (recordsToSave.length > 0) {
            const result = await MatchedSms.insertMany(recordsToSave);
            logger.info(`${result.length} registros casados salvos.`);
        } else {
            logger.info('Nenhum registro completo para salvar');
        }
    } catch (error) {
        logger.error(`Erro ao salvar registros casados: ${error.message}`);
    }
};

const saveMatchedDelayedRecords = async (matchedDelayedRecords) => {
    try {
        const recordsToSave = matchedDelayedRecords.map(({ disparo, retornos }) => {
            const ap_retorno = retornos.find(ret => ret.pdu.esm_class === 4 && ret.parsedMessage.status === 'ENROUTE');
            const op_retorno = retornos.find(ret => ret.pdu.esm_class === 4 && ret.parsedMessage.status !== 'ENROUTE');

            return {
                disparo,
                ap_retorno: ap_retorno ? formatRetorno(ap_retorno) : undefined,
                op_retorno: op_retorno ? formatRetorno(op_retorno) : undefined,
                tm_retorno: undefined // tm_retorno não é necessário neste caso específico
            };
        }).filter(record =>
            record.disparo
        );


        if (recordsToSave.length > 0) {
            const result = await MatchedSms.insertMany(recordsToSave);
            logger.info(`${result.length} registros casados com datas antigas salvos.`);
        } else {
            logger.info('Nenhum registro com datas antigas completo para salvar');
        }
    } catch (error) {
        logger.error(`Erro ao salvar registros casados com datas antigas: ${error.message}`);
    }
};

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
    };
};


const deleteMatchedRecords = async (matchedRecords, totalRecords) => {
    try {
        let deletedCount = 0;
        let lastLoggedPercentage = 0;
        for (const record of matchedRecords) {
            const idsToDelete = [];
            if (record.disparo?._id) {
                idsToDelete.push(record.disparo._id);
            }
            record.retornos.forEach(retorno => {
                if (retorno?._id) {
                    idsToDelete.push(retorno._id);
                }
            });

            for (const id of idsToDelete) {
                await SMS.deleteOne({ _id: id });
                deletedCount++;
                let currentPercentage = Math.floor((deletedCount / totalRecords) * 100);
                currentPercentage = Math.min(currentPercentage, 100);

                if (currentPercentage >= lastLoggedPercentage + 5 && currentPercentage <= 100) {
                    logger.info(`Sanitização da collection em andamento: ${currentPercentage}% ...`);
                    lastLoggedPercentage = currentPercentage;
                }
            }
        }
    } catch (error) {
        logger.error(`Erro ao deletar registros casados: ${error.message}`);
    }
};


const processSmsMatching = async () => {
    try {
        const maxAttempts = 5;
        let attempt = 0;
        const disparoBatchSize = 5000; // Tamanho do lote de disparos
        const reciboBatchSize = 5000; // Tamanho do lote de recibos
        let lastDisparoId = null;

        while (attempt < maxAttempts) {
            logger.info(`Tentativa ${attempt + 1}`);

            // Buscar lote de disparos
            const { disparos } = await fetchSMSReceipts(disparoBatchSize, lastDisparoId);
            if (!disparos || disparos.length === 0) {
                logger.info('Nenhum disparo para processar');
                break;
            }

            let allRetornos = [];
            let lastReciboId = null;
            let moreReceipts = true;

            while (moreReceipts) {
                // Buscar lote de recibos
                const { retornosTransformados } = await fetchSMSReceipts(reciboBatchSize, lastReciboId);

                if (retornosTransformados.length === 0) {
                    moreReceipts = false;
                } else {
                    allRetornos = allRetornos.concat(retornosTransformados);
                    lastReciboId = retornosTransformados[retornosTransformados.length - 1]._id;

                    // Tentar casar registros a cada lote de recibos buscado
                    const matchedRecords = matchRecords(disparos, allRetornos);
                    if (matchedRecords.length > 0) {
                        await saveMatchedRecords(matchedRecords);
                        await deleteMatchedRecords(matchedRecords, matchedRecords.length);

                        // Remover registros casados dos retornos acumulados
                        const matchedIds = new Set(matchedRecords.flatMap(record => [
                            record.disparo._id,
                            ...record.retornos.map(retorno => retorno._id)
                        ]));
                        allRetornos = allRetornos.filter(retorno => !matchedIds.has(retorno._id));

                        // Verificar se todos os disparos foram casados
                        if (matchedRecords.length === disparos.length) {
                            moreReceipts = false;
                        }
                    }

                    // Se não encontrar correspondências e não houver mais recibos a processar
                    if (retornosTransformados.length < reciboBatchSize) {
                        moreReceipts = false;
                    }
                }
            }

            if (!moreReceipts && disparos.length > 0) {
                // Verificação adicional para registros atrasados
                logger.info('Iniciando verificação de registros atrasados (3 dias ou mais)');
                const matchedDelayedRecords = matchRecordsDelayed(disparos, allRetornos);
                if (matchedDelayedRecords.length > 0) {
                    await saveMatchedDelayedRecords(matchedDelayedRecords);
                    await deleteMatchedRecords(matchedDelayedRecords, matchedDelayedRecords.length);
                    logger.warn('Casamento e deleção de registros atrasados completados.');
                } else {
                    logger.info('Nenhum registro atrasado para casar.');
                }
            }

            lastDisparoId = disparos[disparos.length - 1]._id;
            attempt++;

            // Pausa de 2 segundos entre as tentativas
            if (attempt < maxAttempts) {
                logger.info(`Aguardando 5 segundos antes da próxima tentativa...`);
                await sleep(5000);
            }
        }
    } catch (error) {
        logger.error(`Erro no processo de casamento de SMS: ${error.message}`);
    }
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

module.exports = { processSmsMatching }
