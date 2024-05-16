const mongoose = require('mongoose')
const { Schema } = mongoose

const DisparoSchema = new Schema({
    messageId: String,
    vhost: String,
    esmeId: String,
    address_range: String,
    to: String,
    command: String,
    message: String,
    status: String,
    dispatchDate: Date,
    smsFile: {
        file: String,
        tplSMS: String
    }
}, { _id: false })

const RetornoSchema = new Schema({
    command_status: Number,
    sequence_number: Number,
    command: String,
    source_addr: String,
    destination_addr: String,
    esm_class: Number,
    protocol_id: Number,
    priority_flag: Number,
    schedule_delivery_time: String,
    validity_period: String,
    registered_delivery: Number,
    replace_if_present_flag: Number,
    data_coding: Number,
    sm_default_msg_id: Number,
    short_message: {
        messageId: String,
        sub: String,
        delivered: String,
        submitDate: String,
        doneDate: String,
        status: String,
        error: String,
        text: String
    },
    docType: String,
    receiptDate: Date
}, { _id: false })

const MatchedSmsSchema = new Schema({
    disparo: DisparoSchema,
    ap_retorno: RetornoSchema,
    op_retorno: RetornoSchema,
    tm_retorno: RetornoSchema,
    retornos: RetornoSchema
}, { timestamps: true })

const MatchedSms = mongoose.model('MatchedSms', MatchedSmsSchema)

module.exports = MatchedSms
